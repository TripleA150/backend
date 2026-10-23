import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import { Injectable, Logger } from '@nestjs/common';

import { TxKyselyService } from '@common/database';

import { ResolvedProxyConfig } from '@modules/subscription-template/resolve-proxy/interfaces';

import { parseShareLink } from './share-link.parser';

export const INJECTED_HOSTS_FILE = '/var/lib/remnawave/injected-hosts.json';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_LENGTH = 2 * 1024 * 1024;

const OptionsSchema = z.object({
    tags: z.array(z.string()).optional(),
    hidden: z.boolean().optional(),
});

const SourceSchema = OptionsSchema.extend({
    squads: z.array(z.string()).min(1),
    url: z.string().url().optional(),
    keys: z.array(z.union([z.string(), OptionsSchema.extend({ link: z.string() })])).optional(),
});

const FileSchema = z.array(SourceSchema);

/**
 * Serves extra hosts (external share links) to members of internal squads, configured in
 * INJECTED_HOSTS_FILE. The file and its URLs are reloaded in the background every
 * REFRESH_INTERVAL_MS; the last successfully fetched list of a URL is kept on errors.
 */
@Injectable()
export class InjectedHostsService {
    private readonly logger = new Logger(InjectedHostsService.name);

    private hostsBySquad = new Map<string, ResolvedProxyConfig[]>();
    private readonly lastGoodUrlLinks = new Map<string, string[]>();
    private loadedAt = 0;
    private loading: Promise<void> | null = null;

    constructor(private readonly qb: TxKyselyService) {}

    public async getForUser(userId: bigint): Promise<ResolvedProxyConfig[]> {
        if (Date.now() - this.loadedAt > REFRESH_INTERVAL_MS) {
            this.loading ??= this.reload().finally(() => (this.loading = null));
        }
        // Only the very first request waits; later reloads run in the background.
        if (this.loading && this.hostsBySquad.size === 0) await this.loading;

        if (this.hostsBySquad.size === 0) return [];

        const memberships = await this.qb.kysely
            .selectFrom('internalSquadMembers')
            .select('internalSquadUuid')
            .where('userId', '=', userId)
            .execute();

        // The same source may be attached to several of the user's squads.
        return [
            ...new Set(
                memberships.flatMap((m) => this.hostsBySquad.get(m.internalSquadUuid) ?? []),
            ),
        ];
    }

    private async reload(): Promise<void> {
        this.loadedAt = Date.now();

        try {
            let raw: string;
            try {
                raw = await readFile(INJECTED_HOSTS_FILE, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    this.hostsBySquad = new Map();
                    return;
                }
                throw error;
            }

            const parsed = FileSchema.safeParse(JSON.parse(raw));
            if (!parsed.success) {
                this.logger.error(
                    `Invalid ${INJECTED_HOSTS_FILE}, keeping previous state: ${parsed.error.message}`,
                );
                return;
            }

            const squads = await this.qb.kysely
                .selectFrom('internalSquads')
                .select(['uuid', 'name'])
                .execute();

            const next = new Map<string, ResolvedProxyConfig[]>();

            for (const [index, source] of parsed.data.entries()) {
                const entries: { link: string; tags?: string[]; hidden?: boolean }[] = (
                    source.keys ?? []
                ).map((key) => (typeof key === 'string' ? { link: key } : key));

                if (source.url) {
                    const links = await this.fetchLinks(source.url);
                    entries.push(...links.map((link) => ({ link })));
                }

                const hosts: ResolvedProxyConfig[] = [];
                for (const entry of entries) {
                    const host = parseShareLink(entry.link);
                    if (!host) continue;

                    host.metadata.tags = entry.tags ?? source.tags ?? [];
                    host.metadata.isHidden = entry.hidden ?? source.hidden ?? false;
                    hosts.push(host);
                }

                if (hosts.length < entries.length) {
                    this.logger.warn(
                        `Source #${index + 1}: skipped ${entries.length - hosts.length} of ${entries.length} unsupported or invalid links`,
                    );
                }

                for (const ref of source.squads) {
                    const squad = squads.find((s) => s.uuid === ref || s.name === ref);
                    if (!squad) {
                        this.logger.warn(`Source #${index + 1}: internal squad "${ref}" not found`);
                        continue;
                    }
                    next.set(squad.uuid, [...(next.get(squad.uuid) ?? []), ...hosts]);
                }
            }

            this.hostsBySquad = next;
        } catch (error) {
            this.logger.error(`Failed to load ${INJECTED_HOSTS_FILE}: ${error}`);
        }
    }

    private async fetchLinks(url: string): Promise<string[]> {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            let body = await response.text();
            if (body.length > MAX_BODY_LENGTH) throw new Error('response is too large');

            // Subscriptions are served either as plain links or as one base64 blob.
            if (!body.includes('://')) body = Buffer.from(body.trim(), 'base64').toString('utf8');

            const links = body
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line.includes('://'));

            this.lastGoodUrlLinks.set(url, links);
            return links;
        } catch (error) {
            this.logger.error(`Failed to fetch ${url}, using last good copy: ${error}`);
            return this.lastGoodUrlLinks.get(url) ?? [];
        }
    }
}
