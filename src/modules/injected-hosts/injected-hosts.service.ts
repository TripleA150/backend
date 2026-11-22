import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { ProxyAgent } from 'proxy-agent';
import { z } from 'zod';

import { Injectable, Logger } from '@nestjs/common';

import { TxKyselyService } from '@common/database';
import { SUBSCRIPTION_TEMPLATE_TYPE } from '@libs/contracts/constants';

import { ResolvedProxyConfig } from '@modules/subscription-template/resolve-proxy/interfaces';

import { parseShareLink, safeDecode } from './share-link.parser';

export const INJECTED_HOSTS_FILE = '/var/lib/remnawave/injected-hosts.json';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_LENGTH = 10 * 1024 * 1024;

const OptionsSchema = z.object({
    tags: z.array(z.string()).optional(),
    hidden: z.boolean().optional(),
    // Name template: {remark} is the link's own name, {n} its position in the source.
    remark: z.string().optional(),
    excludeFromSubscriptionTypes: z.array(z.enum(SUBSCRIPTION_TEMPLATE_TYPE)).optional(),
    // Name or UUID of an XRAY_JSON subscription template, like a host's Xray JSON template.
    xrayJsonTemplate: z.string().optional(),
});

const SourceSchema = OptionsSchema.extend({
    squads: z.array(z.string()).min(1),
    url: z.string().url().optional(),
    // For Remnawave subscriptions: drop the links of balancer profiles.
    ignoreBalancers: z.boolean().optional(),
    // User-Agent for requests to url; Node's default is "node".
    userAgent: z.string().optional(),
    // How often url is downloaded; the file itself is re-read every REFRESH_INTERVAL_MS.
    refreshMinutes: z.number().int().min(1).optional(),
    // Proxy for requests to url: http(s)://, socks4:// or socks5://, optionally with user:pass@.
    proxy: z
        .string()
        .regex(/^(https?|socks(4a?|5h?)?):\/\/\S+$/, 'expected http(s):// or socks4/5:// proxy URL')
        .optional(),
    keys: z.array(z.union([z.string(), OptionsSchema.extend({ link: z.string() })])).optional(),
});

const FileSchema = z.array(SourceSchema);

// Shadowsocks and VLESS Encryption protect traffic themselves; otherwise TLS or REALITY is required.
function isEncrypted(host: ResolvedProxyConfig): boolean {
    switch (host.protocol) {
        case 'shadowsocks':
            return !['none', 'plain'].includes(host.protocolOptions.method.toLowerCase());
        case 'vless':
            return host.security !== 'none' || host.protocolOptions.encryption !== 'none';
        default:
            return host.security !== 'none';
    }
}

/**
 * Serves extra hosts (external share links) to members of internal squads, configured in
 * INJECTED_HOSTS_FILE. The file and its URLs are reloaded in the background every
 * REFRESH_INTERVAL_MS; the last successfully fetched list of a URL is kept on errors.
 */
@Injectable()
export class InjectedHostsService {
    private readonly logger = new Logger(InjectedHostsService.name);

    private hostsBySquad = new Map<string, ResolvedProxyConfig[]>();
    // Last successful download of each URL and when the next attempt is due.
    private readonly urlCache = new Map<
        string,
        { links: string[]; nextAttemptAt: number; failures: number }
    >();
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

            const templates = await this.qb.kysely
                .selectFrom('subscriptionTemplates')
                .select(['uuid', 'name', 'templateJson'])
                .where('templateType', '=', 'XRAY_JSON')
                .execute();

            const next = new Map<string, ResolvedProxyConfig[]>();

            for (const [index, source] of parsed.data.entries()) {
                const entries: (z.infer<typeof OptionsSchema> & { link: string })[] = (
                    source.keys ?? []
                ).map((key) => (typeof key === 'string' ? { link: key } : key));

                if (source.url) {
                    const links = await this.fetchLinks(source.url, source);
                    entries.push(...links.map((link) => ({ link })));
                }

                const findTemplate = (ref: string | undefined): object | null => {
                    if (!ref) return null;
                    const template = templates.find((t) => t.uuid === ref || t.name === ref);
                    if (!template) {
                        this.logger.warn(
                            `Source #${index + 1}: XRAY_JSON template "${ref}" not found`,
                        );
                    }
                    return (template?.templateJson as object | null | undefined) ?? null;
                };
                const sourceTemplate = findTemplate(source.xrayJsonTemplate);

                const hosts: ResolvedProxyConfig[] = [];
                for (const entry of entries) {
                    const host = parseShareLink(entry.link);
                    if (!host || !isEncrypted(host)) continue;

                    host.metadata.tags = entry.tags ?? source.tags ?? [];
                    host.metadata.isHidden = entry.hidden ?? source.hidden ?? false;
                    host.metadata.excludeFromSubscriptionTypes =
                        entry.excludeFromSubscriptionTypes ??
                        source.excludeFromSubscriptionTypes ??
                        [];
                    host.clientOverrides.xrayJsonTemplate = entry.xrayJsonTemplate
                        ? findTemplate(entry.xrayJsonTemplate)
                        : sourceTemplate;

                    const remark = entry.remark ?? source.remark;
                    if (remark) {
                        const original = host.finalRemark;
                        const n = String(hosts.length + 1);
                        host.finalRemark = host.metadata.remark = remark.replace(
                            /\{(remark|n)\}/g,
                            (_: string, key: string) => (key === 'n' ? n : original),
                        );
                    }

                    hosts.push(host);
                }

                if (hosts.length < entries.length) {
                    this.logger.warn(
                        `Source #${index + 1}: skipped ${entries.length - hosts.length} of ${entries.length} unsupported, invalid or unencrypted links`,
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

    private async fetchLinks(
        url: string,
        {
            ignoreBalancers,
            userAgent,
            refreshMinutes,
            proxy,
        }: {
            ignoreBalancers?: boolean;
            userAgent?: string;
            refreshMinutes?: number;
            proxy?: string;
        },
    ): Promise<string[]> {
        // A changed proxy gets a fresh entry, so it is tried at once instead of after a backoff.
        const cacheKey = `${!!ignoreBalancers}:${userAgent ?? ''}:${proxy ?? ''}:${url}`;
        const cached = this.urlCache.get(cacheKey);
        const startedAt = Date.now();
        if (cached && startedAt < cached.nextAttemptAt) return cached.links;

        const refreshMs = Math.max(refreshMinutes ?? 0, 5) * 60_000;

        try {
            let body = await this.fetchText(url, userAgent, proxy);

            // Subscriptions are served either as plain links or as one base64 blob.
            if (!body.includes('://')) body = Buffer.from(body.trim(), 'base64').toString('utf8');

            let links = body
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => /^[a-z0-9]+:\/\//i.test(line));
            if (links.length === 0) throw new Error('no share links in the response');

            if (ignoreBalancers) {
                const balancers = await this.fetchBalancerRemarks(url, userAgent, proxy);
                links = links.filter(
                    (link) => !balancers.has(safeDecode(link.split('#')[1] ?? '')),
                );
            }

            this.urlCache.set(cacheKey, {
                links,
                nextAttemptAt: startedAt + refreshMs,
                failures: 0,
            });
            return links;
        } catch (error) {
            // Back off 5, 10, 20... minutes, at most the refresh interval, so a failing or banning
            // source is not hammered every reload.
            const failures = (cached?.failures ?? 0) + 1;
            const delayMs = Math.min(5 * 60_000 * 2 ** (failures - 1), refreshMs);
            const links = cached?.links ?? [];
            this.urlCache.set(cacheKey, { links, nextAttemptAt: startedAt + delayMs, failures });
            this.logger.error(
                `Failed to fetch ${url}, using last good copy, next attempt in ${delayMs / 60_000} min: ${error}`,
            );
            return links;
        }
    }

    // A Remnawave panel serves every profile as XRAY_JSON at <subscription>/json; balancer
    // profiles are the ones with routing.balancers, and share the remark of their base64 link.
    private async fetchBalancerRemarks(
        url: string,
        userAgent?: string,
        proxy?: string,
    ): Promise<Set<string>> {
        const jsonUrl = new URL(url);
        jsonUrl.pathname = `${jsonUrl.pathname.replace(/\/$/, '')}/json`;

        const profiles: unknown = JSON.parse(
            await this.fetchText(jsonUrl.toString(), userAgent, proxy),
        );
        if (!Array.isArray(profiles))
            throw new Error(`${jsonUrl.pathname} is not an XRAY_JSON list`);

        return new Set(
            (profiles as { remarks?: unknown; routing?: { balancers?: unknown[] } }[])
                .filter((profile) => profile?.routing?.balancers?.length)
                .map((profile) => String(profile.remarks)),
        );
    }

    private async fetchText(url: string, userAgent?: string, proxy?: string): Promise<string> {
        if (proxy) {
            // Same proxy handling as the Telegram bot (TELEGRAM_BOT_PROXY).
            const agent = new ProxyAgent({ getProxyForUrl: () => proxy });
            const response = await axios.get<string>(url, {
                // Keep fetch's default User-Agent, providers pick the response format by it.
                headers: { 'user-agent': userAgent ?? 'node' },
                httpAgent: agent,
                httpsAgent: agent,
                proxy: false,
                responseType: 'text',
                transformResponse: (data: string) => data,
                timeout: FETCH_TIMEOUT_MS,
                maxContentLength: MAX_BODY_LENGTH,
            });
            return response.data;
        }

        const response = await fetch(url, {
            headers: userAgent ? { 'user-agent': userAgent } : undefined,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = await response.text();
        if (body.length > MAX_BODY_LENGTH) throw new Error('response is too large');
        return body;
    }
}
