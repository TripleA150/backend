import { HostsSchema } from '../hosts.schema';

export const ResponseRuleHostOverridesSchema = HostsSchema.pick({
    serverDescription: true,
    vlessRouteId: true,
}).partial();
