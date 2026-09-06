import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "profile_stats_deleted_tokens", "estimated"))) {
    yield* sql`ALTER TABLE profile_stats_deleted_tokens ADD COLUMN estimated INTEGER NOT NULL DEFAULT 1`;
  }
});
