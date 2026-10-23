# Injected hosts

This fork can add external connection keys to the subscriptions of members of selected internal
squads. Keys come from a subscription URL (a list of share links, plain text or base64) or are
listed one by one. They are configured in a JSON file; there are no database changes.

## Configuration file

Mount the file into the container at `/var/lib/remnawave/injected-hosts.json`:

```yaml
services:
    remnawave:
        image: ghcr.io/triplea150/remnawave-backend:latest
        volumes:
            - ./injected-hosts.json:/var/lib/remnawave/injected-hosts.json:ro
```

Example:

```json
[
    {
        "squads": ["Whitelist"],
        "url": "https://raw.githubusercontent.com/zieng2/wl/refs/heads/main/vless_universal.txt",
        "tags": ["wl"],
        "hidden": true
    },
    {
        "squads": ["Whitelist", "6f1c0c1e-0000-4000-8000-000000000000"],
        "keys": [
            "vless://uuid@203.0.113.10:443?type=tcp&security=reality&pbk=...&sni=example.com#Key 1",
            { "link": "trojan://password@203.0.113.11:443?type=ws&path=%2Fws#Key 2", "tags": ["vip"] }
        ]
    }
]
```

Each entry is a source:

| Field    | Description                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------- |
| `squads` | Internal squads (name or UUID) whose members receive the keys. Required.                        |
| `url`    | Subscription URL with share links, one per line or base64-encoded.                              |
| `keys`   | Share links. Each item is a string or `{ "link", "tags", "hidden" }` to override the source.    |
| `tags`   | Host tags given to every key of the source. Used by `tagRegex` selectors and response rules.    |
| `hidden` | `true` makes the keys hidden hosts: they are only used through `injectHosts`. Default `false`. |

Supported links: `vless`, `trojan`, `ss` (without plugins), `hysteria2`/`hy2`, with the `tcp`/`raw`,
`ws`, `httpupgrade`, `grpc`, `xhttp` and `kcp` transports and `tls`/`reality`/`none` security.
Other links are skipped and counted in the log.

## Behaviour

- Keys are added after the user's own hosts, in every subscription format and on the
  subscription page.
- Only users with the `ACTIVE` status get them. Expired, limited and disabled users do not, and
  neither do users blocked by the HWID device limit.
- The file and the URLs are reloaded every 5 minutes; changes need no restart. If a URL cannot
  be fetched, its last successful copy is used. If the file is invalid, the previous state is
  kept and the error is logged. Without the file the feature is off.
- Hidden keys behave like hidden hosts: they are served only with `XRAY_JSON` and `MIHOMO`
  subscriptions (for Mihomo, when the template sets `includeHiddenHosts`).
- Response rules that exclude hosts by tag also exclude injected keys with that tag.
- Traffic through external servers is not counted against user limits, and users keep the keys
  they have already downloaded.

## Using tags in a balancer

Injected keys can be selected by the `remnawave.injectHosts` directive of an `XRAY_JSON`
template, as described in https://docs.rw/learn/xray-json-advanced. The virtual host that carries
the template is a regular panel host available to the user; the injected keys are selected by tag:

```json
{
    "remnawave": {
        "injectHosts": [
            {
                "selector": { "type": "tagRegex", "pattern": "^wl$" },
                "tagPrefix": "wl"
            }
        ]
    },
    "burstObservatory": {
        "pingConfig": {
            "timeout": "3s",
            "interval": "1m",
            "sampling": 1,
            "destination": "http://www.gstatic.com/generate_204"
        },
        "subjectSelector": ["wl"]
    },
    "routing": {
        "balancers": [
            {
                "tag": "WL_Balancer",
                "selector": ["wl"],
                "strategy": { "type": "leastLoad" },
                "fallbackTag": "direct"
            }
        ],
        "rules": [{ "network": "tcp,udp", "balancerTag": "WL_Balancer" }]
    },
    "outbounds": [
        { "tag": "direct", "protocol": "freedom" },
        { "tag": "block", "protocol": "blackhole" }
    ]
}
```

With `"hidden": true` on the source, the default `selectFrom: "HIDDEN"` picks the keys and they do
not appear as separate entries. For visible keys use `"selectFrom": "ALL"` or `"NOT_HIDDEN"`.
Use `tagPrefix` rather than `useHostTagAsTag`: keys sharing one tag would produce duplicate
outbound tags.

## Build and deployment

The `Build custom image` workflow builds the `custom` branch on every push and publishes
`ghcr.io/<owner>/remnawave-backend:latest` and `ghcr.io/<owner>/remnawave-backend:<version>-<commit>`. The image is
built from the upstream Dockerfile and contains the upstream frontend.

To update the server:

```sh
docker compose pull && docker compose up -d
```

To return to the upstream image, set `image: remnawave/backend:3` again.

## Syncing with upstream

`main` mirrors `remnawave/backend`. To update, sync `main` on GitHub and merge it into `custom`;
the push triggers a new build. The feature lives in `src/modules/injected-hosts/`; the only
changes to upstream files are small hooks in:

- `src/modules/subscription-template/resolve-proxy/resolve-proxy-config.service.ts`
- `src/modules/subscription-template/render-templates.service.ts`
- `src/modules/subscription-template/subscription-template.module.ts`
- `src/modules/subscription/subscription.service.ts`
