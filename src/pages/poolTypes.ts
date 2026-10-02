// src/pages/poolTypes.ts — local aliases for the generated schema types
// (the SDK re-exports the leaf types; filter/selector sub-shapes are pulled
// straight from the generated components).

import type { Pool } from "@goose-network/goose-sdk";
import type { components } from "@goose-network/goose-sdk";

export type { Pool };
export type FilterSpec = components["schemas"]["config.FilterSpec"];
