# ADR-0001: Keep Automation Command route policy behind verified behavior

## Status

Accepted

## Decision

The six label-triggered Automation Command families share one policy: public operation, authorized Target operation, trigger label, Automation Work Item receiver, and canonical scheduler identity. `.sandcastle/automation-command-route.ts` owns that relation and exposes only verified behavior for resolving either operation direction, validating complete commands, enumerating receiver-scoped routes, and listing canonical triggers.

Discovery remains responsible for GitHub shape reads, top-level Issue and Spec classification, open implementation Pull Request detection, and competing-trigger priority. Eligibility and priority remain in Automation Command code. CLI names and wording remain CLI presentation. GitHub-capable Agent readiness, Target runtime profile/model composition, fixed operation entries, timeouts, managed GitHub lifecycle and security checks, staged acquisition authorization, and Target Checkout remain their existing independent seams.

`unknown` stays inspection-only. Queue promotion has no route. Scheduled architecture review remains a no-Work-Item Target invocation and is not label-triggered route policy.

## Consequences

Callers cannot combine a raw declaration or retain fallback mappings. The route contract uses a hand-authored matrix, while independent composition, readiness, runtime, timeout, fixed-entry, scheduled, queue-promotion, and layered-authorization matrices remain external drift alarms.

Deleting the route module breaks route construction across discovery, Dispatcher validation, acquisition, direct CLI composition, and managed lifecycle projection. It does not remove the unrelated execution, security, or business seams listed above; recreating the route relation at those callers would violate this decision.
