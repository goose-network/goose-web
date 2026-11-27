// src/pages/poolTypes.ts — local aliases for the generated schema types
// (the SDK re-exports the leaf types; filter/selector sub-shapes are pulled
// straight from the generated components).

import type { Pool as SdkPool } from "@goose-network/goose-sdk";
import type { components } from "@goose-network/goose-sdk";

/** The SDK's Pool, extended locally with chain membership. A pool created
 *  by full-probe pool apply carries the member chains alongside its outbound
 *  set; the pinned SDK predates the field, so it is declared here until the
 *  next regeneration. Additive and optional: an engine (or pool) without it
 *  simply never sends it, and the form must round-trip it untouched when it
 *  is there — dropping it on save would silently strip the chain members. */
export type Pool = SdkPool & {
  chain_ids?: string[];
};
export type FilterSpec = components["schemas"]["config.FilterSpec"];
