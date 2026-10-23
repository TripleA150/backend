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

The `Sync upstream release` workflow runs every 6 hours. It merges the latest release tag of
`remnawave/backend` (for example `3.4.8`, the code of the official image) into `custom`,
type-checks the result, pushes it and starts the image build. If the merge conflicts or the check
fails, nothing is pushed to `custom`: the run fails (GitHub emails you), its summary lists the
problem and a `sync/<tag>` branch is left for the manual merge described below.

To merge a specific tag, or to retry right away: Actions → Sync upstream release → Run workflow.

### One-time setup

1. Settings → General → Default branch: select `custom`. Scheduled workflows only run from the
   default branch. Do not use the "Sync fork" button afterwards: it merges upstream `main`, which
   may contain unreleased code.
2. Actions: disable the upstream workflows (`Build&Push Release Docker Image`, `Build&Push Dev
   Docker Image`, `Deploy backend contracts`, `Push OpenAPI specs`, `Release to panel`). They
   publish to Remnawave's own registries and fail in a fork; `Deploy backend contracts` would run
   on every release that changes `libs/contract/package.json`.
3. Optional: add a `SYNC_TOKEN` repository secret (Settings → Secrets and variables → Actions)
   with a fine-grained personal access token for this repository with the **Contents** and
   **Workflows** read and write permissions. GitHub does not let the built-in token push commits
   that change `.github/workflows`, so without it a release that edits workflow files (rare) ends
   as a failed sync that has to be merged manually.

### Our changes to upstream files

The feature lives in `src/modules/injected-hosts/`, which upstream never touches. Upstream files
only carry these hooks; this is what has to survive every merge:

`src/modules/subscription-template/resolve-proxy/resolve-proxy-config.service.ts`

```ts
import { InjectedHostsService } from '@modules/injected-hosts/injected-hosts.service';

export interface IResolveProxyConfigOptions {
    // ...upstream fields...
    // Append hosts from the injected hosts file; 'NOT_HIDDEN' where hidden hosts are not served.
    injectedHosts?: 'ALL' | 'NOT_HIDDEN';
}

constructor(
    private readonly configService: TypedConfigService,
    private readonly injectedHostsService: InjectedHostsService,
) {

// in resolveProxyConfig(), right before resolveEarlyExitRemarks():
const injectedHosts = await this.getInjectedHosts(options);
// ...and its host count argument becomes:
options.hosts.length + injectedHosts.length,

// at the end of resolveProxyConfig(), before `return resolvedProxyConfigs;`:
for (const injectedHost of injectedHosts) {
    resolvedProxyConfigs.push({
        ...injectedHost,
        finalRemark: this.deduplicateRemark(injectedHost.finalRemark, knownRemarks),
    });
}

// plus the private getInjectedHosts(options) method
```

`src/modules/subscription-template/render-templates.service.ts`: in `generateSubscription()`

```ts
injectedHosts:
    srrContext.matchedResponseType === 'XRAY_JSON' ||
    srrContext.matchedResponseType === 'MIHOMO'
        ? 'ALL'
        : 'NOT_HIDDEN',
```

and `injectedHosts: 'ALL'` in `generateRawSubscription()`.

`src/modules/subscription-template/subscription-template.module.ts`: `InjectedHostsService` in
`providers` (and its import).

`src/modules/subscription/subscription.service.ts`: `injectedHosts: 'NOT_HIDDEN'` in the
`resolveProxyConfig()` call of `getSubscriptionInfo()`.

`git diff <upstream tag> custom -- src/modules/subscription-template src/modules/subscription`
shows the current hooks at any time.

### Resolving a failed sync

One-time local setup:

```sh
git clone https://github.com/TripleA150/backend.git && cd backend
git remote add upstream https://github.com/remnawave/backend.git
git config user.name "TripleA150"
git config user.email "46062533+TripleA150@users.noreply.github.com"
```

Merge the release named in the failed run:

```sh
git switch custom && git pull
git fetch upstream --tags
git merge 3.4.8
```

**If git reports conflicts**, `git status` lists the files. In each conflict block, the part between
`<<<<<<< HEAD` and `=======` is ours, the part up to `>>>>>>> 3.4.8` is upstream's. Keep upstream's
code and re-add our hook lines from the section above, so upstream changes are never lost. Remove
the markers, then:

```sh
git add <file>        # for every resolved file
git commit --no-edit
```

To start over at any point: `git merge --abort`.

Conflicts outside the four files above are not caused by this fork: take upstream's version with
`git checkout --theirs <file> && git add <file>`.

**If the merge was clean but the type check failed**, upstream changed something our code uses.
Typical cases:

- the `ResolvedProxyConfig` type gained or renamed fields: update `build()` and the transport or
  security helpers in `src/modules/injected-hosts/share-link.parser.ts`;
- `IResolveProxyConfigOptions`, `resolveEarlyExitRemarks()` or `deduplicateRemark()` changed:
  re-apply the hook in `resolve-proxy-config.service.ts` to the new code;
- the `internalSquads` or `internalSquadMembers` tables were renamed: update the two queries in
  `injected-hosts.service.ts`.

**Check before pushing** (the same check the workflow runs, plus lint and build):

```sh
npm ci
npm run migrate:generate
npx tsc --noEmit
npm run check
npm run build
git push origin custom
```

The push builds the image. The next scheduled sync sees that `custom` contains the release and
does nothing. Delete the `sync/<tag>` branch on GitHub. After deploying, open one subscription of
a squad with injected keys and check that they are present.
