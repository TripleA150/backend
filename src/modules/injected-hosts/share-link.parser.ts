import { createHash } from 'node:crypto';
import { VLessFlow } from 'xray-typed';

import {
    ResolvedProxyConfig,
    SecurityVariant,
    TransportVariant,
} from '@modules/subscription-template/resolve-proxy/interfaces';

/**
 * Parses an external share link (vless, trojan, ss, hysteria2) into a ResolvedProxyConfig,
 * the inverse of XrayGeneratorService. Returns null for unsupported or malformed links.
 */
export function parseShareLink(link: string): ResolvedProxyConfig | null {
    try {
        const match = /^([a-z0-9]+):\/\/([^#]*)(?:#(.*))?$/i.exec(link.trim());
        if (!match) return null;

        const [, rawScheme, body, rawRemark] = match;
        const scheme = rawScheme.toLowerCase();
        const remark = rawRemark ? safeDecode(rawRemark) : '';

        if (scheme === 'ss') return parseShadowsocks(body, remark, link);

        const target = parseTarget(body);
        if (!target) return null;

        switch (scheme) {
            case 'vless': {
                const transport = parseTransport(target.params);
                if (!transport) return null;
                return build(
                    link,
                    remark,
                    target,
                    transport,
                    parseSecurity(target.params, 'none'),
                    {
                        protocol: 'vless',
                        protocolOptions: {
                            id: target.userinfo,
                            encryption: target.params.encryption || 'none',
                            flow: (target.params.flow || '') as VLessFlow,
                        },
                    },
                );
            }
            case 'trojan': {
                const transport = parseTransport(target.params);
                if (!transport) return null;
                return build(link, remark, target, transport, parseSecurity(target.params, 'tls'), {
                    protocol: 'trojan',
                    protocolOptions: { password: target.userinfo },
                });
            }
            case 'hysteria2':
            case 'hy2': {
                const { params } = target;
                const config = build(
                    link,
                    remark,
                    target,
                    {
                        transport: 'hysteria',
                        transportOptions: { version: 2, auth: target.userinfo },
                    },
                    tlsSecurity({ ...params, pcs: params.pinSHA256 }),
                    { protocol: 'hysteria', protocolOptions: { version: 2 } },
                );
                if (!config.streamOverrides.finalMask && params.obfs === 'salamander') {
                    config.streamOverrides.finalMask = {
                        udp: [
                            { type: 'salamander', settings: { password: params['obfs-password'] } },
                        ],
                    };
                }
                return config;
            }
            default:
                return null;
        }
    } catch {
        return null;
    }
}

interface ILinkTarget {
    userinfo: string;
    address: string;
    port: number;
    params: Record<string, string>;
}

function parseTarget(body: string): ILinkTarget | null {
    const queryStart = body.indexOf('?');
    const authority = queryStart === -1 ? body : body.slice(0, queryStart);
    const query = queryStart === -1 ? '' : body.slice(queryStart + 1);

    const at = authority.lastIndexOf('@');
    if (at === -1) return null;

    const userinfo = safeDecode(authority.slice(0, at));
    const hostPort = authority.slice(at + 1).replace(/\/$/, '');

    const hostMatch = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(hostPort);
    if (!hostMatch || !userinfo) return null;

    const port = Number(hostMatch[2]);
    if (port < 1 || port > 65535) return null;

    return {
        userinfo,
        address: hostMatch[1].replace(/^\[|\]$/g, ''),
        port,
        params: parseQuery(query),
    };
}

// URLSearchParams would turn '+' into a space, which corrupts base64-like values.
function parseQuery(query: string): Record<string, string> {
    const params: Record<string, string> = {};
    for (const part of query.split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const key = safeDecode(eq === -1 ? part : part.slice(0, eq));
        params[key] = eq === -1 ? '' : safeDecode(part.slice(eq + 1));
    }
    return params;
}

function parseTransport(params: Record<string, string>): TransportVariant | null {
    switch (params.type || 'tcp') {
        case 'tcp':
        case 'raw':
            return {
                transport: 'tcp',
                transportOptions: {
                    header:
                        params.headerType === 'http'
                            ? ({
                                  type: 'http',
                                  request: {
                                      path: (params.path || '/').split(','),
                                      headers: params.host ? { Host: params.host.split(',') } : {},
                                  },
                              } as never)
                            : null,
                },
            };
        case 'ws':
            return {
                transport: 'ws',
                transportOptions: {
                    path: params.path || null,
                    host: params.host || null,
                    headers: null,
                    heartbeatPeriod: Number(params.heartbeatPeriod) || null,
                },
            };
        case 'httpupgrade':
            return {
                transport: 'httpupgrade',
                transportOptions: {
                    path: params.path || null,
                    host: params.host || null,
                    headers: null,
                },
            };
        case 'grpc':
            return {
                transport: 'grpc',
                transportOptions: {
                    serviceName: params.serviceName || null,
                    authority: params.authority || null,
                    multiMode: params.mode === 'multi',
                },
            };
        case 'xhttp':
        case 'splithttp':
            return {
                transport: 'xhttp',
                transportOptions: {
                    path: params.path || null,
                    host: params.host || null,
                    mode: (params.mode || 'auto') as 'auto',
                    extra: parseJson(params.extra),
                },
            };
        case 'kcp':
        case 'mkcp':
            return {
                transport: 'kcp',
                transportOptions: {
                    clientMtu: Number(params.mtu) || 1350,
                    clientTti: Number(params.tti) || 50,
                    congestion: false,
                },
            };
        default:
            return null;
    }
}

function parseSecurity(
    params: Record<string, string>,
    defaultSecurity: 'none' | 'tls',
): SecurityVariant {
    switch (params.security || defaultSecurity) {
        case 'tls':
            return tlsSecurity(params);
        case 'reality':
            return {
                security: 'reality',
                securityOptions: {
                    fingerprint: params.fp || 'chrome',
                    publicKey: params.pbk || '',
                    shortId: params.sid || null,
                    serverName: params.sni || '',
                    spiderX: params.spx || null,
                    mldsa65Verify: params.pqv || null,
                },
            };
        default:
            return { security: 'none' };
    }
}

function tlsSecurity(params: Record<string, string | undefined>): SecurityVariant {
    return {
        security: 'tls',
        securityOptions: {
            serverName: params.sni || params.peer || null,
            fingerprint: params.fp || 'chrome',
            alpn: params.alpn || null,
            pinnedPeerCertSha256: params.pcs || null,
            verifyPeerCertByName: params.vcn || null,
            cipherSuites: params.cs || null,
            echConfigList: params.ech || null,
            echForceQuery: null,
            echSockopt: null,
            enableSessionResumption: false,
        },
    };
}

// SIP002: ss://base64(method:password)@host:port[/?plugin=...]#remark
// Legacy: ss://base64(method:password@host:port)#remark
function parseShadowsocks(body: string, remark: string, link: string): ResolvedProxyConfig | null {
    const target = parseTarget(
        body.includes('@') ? body : decodeBase64(body.replace(/\/?\?.*$/, '')),
    );
    if (!target || target.params.plugin) return null;

    const credentials = target.userinfo.includes(':')
        ? target.userinfo
        : decodeBase64(target.userinfo);
    const sep = credentials.indexOf(':');
    if (sep === -1) return null;

    return build(
        link,
        remark,
        target,
        { transport: 'tcp', transportOptions: { header: null } },
        { security: 'none' },
        {
            protocol: 'shadowsocks',
            protocolOptions: {
                method: credentials.slice(0, sep),
                password: credentials.slice(sep + 1),
                uot: false,
                uotVersion: 1,
            },
        },
    );
}

function build(
    link: string,
    remark: string,
    target: ILinkTarget,
    transport: TransportVariant,
    security: SecurityVariant,
    protocol: Pick<ResolvedProxyConfig, 'protocol' | 'protocolOptions'>,
): ResolvedProxyConfig {
    const finalRemark = remark || `${target.address}:${target.port}`;

    return {
        finalRemark,
        address: target.address,
        port: target.port,
        streamOverrides: { finalMask: parseJson(target.params.fm), sockopt: null },
        mux: null,
        clientOverrides: {
            shuffleHost: false,
            mihomoX25519: false,
            mihomoIpVersion: null,
            serverDescription: null,
            xrayJsonTemplate: null,
            mapper: {},
        },
        metadata: {
            uuid: hashToUuid(link),
            tags: [],
            excludeFromSubscriptionTypes: [],
            inboundTag: '',
            configProfileUuid: null,
            configProfileInboundUuid: null,
            isDisabled: false,
            isHidden: false,
            viewPosition: 0,
            remark: finalRemark,
            vlessRouteId: null,
            rawInbound: null,
        },
        ...protocol,
        ...security,
        ...transport,
    } as ResolvedProxyConfig;
}

function hashToUuid(value: string): string {
    const hex = createHash('sha256').update(value).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseJson(value: string | undefined): Record<string, unknown> | null {
    if (!value) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function decodeBase64(value: string): string {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
