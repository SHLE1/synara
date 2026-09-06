import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Maps every turn to the provider/model selected when it was started: turn-start
// events carry the pending messageId, which projection_turns links back to the
// turn_id that token activities reference. Shared by the live token stats query
// and the delete-time archive snapshot so both attribute token deltas the same
// way. Pass `scope` to restrict the CTE to a single thread (archive path).
export function turnModelSelectionCte(
  sql: SqlClient.SqlClient,
  scope?: { readonly threadId: string },
) {
  const turnThreadMatch = scope
    ? sql`${scope.threadId}`
    : sql.literal("json_extract(e.payload_json, '$.threadId')");
  const eventThreadScope = scope
    ? sql`AND COALESCE(json_extract(e.payload_json, '$.threadId'), e.stream_id) = ${scope.threadId}`
    : sql.literal("");
  return sql`
    SELECT
      pt.thread_id AS thread_id,
      pt.turn_id AS turn_id,
      MAX(json_extract(e.payload_json, '$.modelSelection.provider')) AS provider,
      MAX(json_extract(e.payload_json, '$.modelSelection.model')) AS model
    FROM orchestration_events e
    JOIN projection_turns pt
      ON pt.thread_id = ${turnThreadMatch}
     AND pt.pending_message_id = json_extract(e.payload_json, '$.messageId')
    WHERE e.event_type = 'thread.turn-start-requested'
      ${eventThreadScope}
      AND pt.turn_id IS NOT NULL
      AND json_type(e.payload_json, '$.modelSelection') = 'object'
    GROUP BY pt.thread_id, pt.turn_id
  `;
}

// Independent consumption records are authoritative for their turn. Native
// source identifiers make prompt replays idempotent even under a new turn ID.
// Cumulative counters are scoped to the emitting provider session; turn totals
// may decrease between prompts and must never be differenced. Legacy window
// deltas remain estimates only before the provider first reports explicit usage
// in a thread. Later legacy intervals may span explicit-only turns, so mixing
// them back in could double-count consumption. Never subtract across scales.
// Both live queries and deletion snapshots use these CTEs to preserve totals.
export function profileTokenActivityCtes(
  sql: SqlClient.SqlClient,
  scope?: { readonly threadId: string },
) {
  return sql`
        WITH turn_model AS (
          ${turnModelSelectionCte(sql, scope)}
        ),
        ev AS (
          SELECT
            a.thread_id AS thread_id,
            a.turn_id AS turn_id,
            a.created_at AS day,
            COALESCE(
              tm.provider,
              json_extract(a.payload_json, '$.provider'),
              CASE
                WHEN th.model_selection_json IS NOT NULL AND json_valid(th.model_selection_json)
                THEN json_extract(th.model_selection_json, '$.provider')
              END,
              'unknown'
            ) AS provider,
            COALESCE(
              tm.model,
              CASE
                WHEN th.model_selection_json IS NOT NULL
                  AND json_valid(th.model_selection_json)
                  AND (
                    json_extract(a.payload_json, '$.provider') IS NULL
                    OR json_extract(a.payload_json, '$.provider') =
                      json_extract(th.model_selection_json, '$.provider')
                  )
                THEN json_extract(th.model_selection_json, '$.model')
              END,
              'unknown'
            ) AS model,
            CAST(json_extract(a.payload_json, '$.totalProcessedTokens') AS INTEGER) AS tp,
            CAST(json_extract(a.payload_json, '$.usedTokens') AS INTEGER) AS ut,
            pm.dispatch_origin AS dispatch_origin,
            a.sequence AS sequence,
            a.created_at AS created_at,
            a.activity_id AS activity_id
          FROM projection_thread_activities a
          JOIN projection_threads th ON th.thread_id = a.thread_id
          LEFT JOIN turn_model tm
            ON tm.thread_id = a.thread_id
           AND tm.turn_id = a.turn_id
          LEFT JOIN projection_turns pt
            ON pt.thread_id = a.thread_id
           AND pt.turn_id = a.turn_id
          LEFT JOIN projection_thread_messages pm
            ON pm.thread_id = pt.thread_id
           AND pm.message_id = pt.pending_message_id
          WHERE a.kind = 'context-window.updated'
            ${scope ? sql`AND a.thread_id = ${scope.threadId}` : sql.literal("")}
            AND COALESCE(
              json_extract(a.payload_json, '$.totalProcessedTokens'),
              json_extract(a.payload_json, '$.usedTokens')
            ) IS NOT NULL
        ),
        provider_model_scale AS (
          SELECT thread_id, provider, model, MAX(tp IS NOT NULL) AS has_cumulative
          FROM ev
          GROUP BY thread_id, provider, model
        ),
        cumulative_kept AS (
          SELECT
            day,
            thread_id,
            turn_id,
            provider,
            model,
            tp AS tot,
            dispatch_origin,
            sequence,
            created_at,
            activity_id
          FROM ev
          WHERE tp IS NOT NULL
        ),
        cumulative_delta AS (
          SELECT
            day,
            thread_id,
            turn_id,
            provider,
            model,
            dispatch_origin,
            CASE
              WHEN previous_tot IS NULL OR tot < previous_tot THEN tot
              ELSE MAX(0, tot - previous_tot)
            END AS d
          FROM (
            SELECT
              day,
              thread_id,
              turn_id,
              provider,
              model,
              dispatch_origin,
              tot,
              LAG(tot) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_tot
            FROM cumulative_kept
          )
        ),
        used_only_kept AS (
          SELECT
            ev.day AS day,
            ev.provider AS provider,
            ev.model AS model,
            ev.thread_id AS thread_id,
            ev.turn_id AS turn_id,
            ev.ut AS tot,
            ev.dispatch_origin AS dispatch_origin,
            ev.sequence AS sequence,
            ev.created_at AS created_at,
            ev.activity_id AS activity_id
          FROM ev
          JOIN provider_model_scale pms
            ON pms.thread_id = ev.thread_id
           AND pms.provider = ev.provider
           AND pms.model = ev.model
          WHERE ev.tp IS NULL
            AND ev.ut IS NOT NULL
            AND NOT pms.has_cumulative
        ),
        used_only_delta AS (
          SELECT
            day,
            thread_id,
            turn_id,
            provider,
            model,
            dispatch_origin,
            CASE
              WHEN previous_tot IS NULL THEN tot
              WHEN tot < previous_tot
                AND (provider != previous_provider OR model != previous_model)
              THEN tot
              ELSE MAX(0, tot - previous_tot)
            END AS d
          FROM (
            SELECT
              day,
              thread_id,
              turn_id,
              provider,
              model,
              dispatch_origin,
              tot,
              LAG(tot) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_tot,
              LAG(provider) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_provider,
              LAG(model) OVER (
                PARTITION BY thread_id
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
              ) AS previous_model
            FROM used_only_kept
          )
        ),

        consumption_raw AS (
          SELECT a.thread_id, a.turn_id, a.created_at, a.sequence, a.activity_id,
            json_extract(a.payload_json, '$.provider') AS provider,
            COALESCE(tm.model, 'unknown') AS model,
            json_extract(a.payload_json, '$.sessionId') AS session_id,
            COALESCE(json_extract(a.payload_json, '$.sourceId'), a.turn_id) AS source_id,
            json_extract(a.payload_json, '$.scope') AS scope,
            CAST(json_extract(a.payload_json, '$.usage.totalTokens') AS INTEGER) AS total,
            pm.dispatch_origin
          FROM projection_thread_activities a
          JOIN projection_threads th ON th.thread_id = a.thread_id
          LEFT JOIN turn_model tm ON tm.thread_id = a.thread_id AND tm.turn_id = a.turn_id
            AND tm.provider = json_extract(a.payload_json, '$.provider')
          LEFT JOIN projection_turns pt ON pt.thread_id = a.thread_id AND pt.turn_id = a.turn_id
          LEFT JOIN projection_thread_messages pm
            ON pm.thread_id = pt.thread_id AND pm.message_id = pt.pending_message_id
          WHERE a.kind = 'token-usage.updated'
            ${scope ? sql`AND a.thread_id = ${scope.threadId}` : sql.literal("")}
            AND a.turn_id IS NOT NULL
            AND json_extract(a.payload_json, '$.scope') IN ('turn', 'session')
            AND json_type(a.payload_json, '$.usage.totalTokens') IN ('integer', 'real')
            AND json_extract(a.payload_json, '$.usage.totalTokens') >= 0
            AND json_extract(a.payload_json, '$.provider') IS NOT NULL
            AND json_extract(a.payload_json, '$.sessionId') IS NOT NULL
        ),
        consumption_ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY thread_id, provider, session_id, source_id, scope
            ORDER BY total DESC, sequence ASC, created_at ASC, activity_id ASC
          ) AS rank
          FROM consumption_raw
        ),
        consumption_delta AS (
          SELECT *, CASE WHEN scope = 'turn' THEN total
            WHEN previous_total IS NULL OR total < previous_total THEN total
            ELSE total - previous_total END AS tokens
          FROM (
            SELECT *, LAG(total) OVER (
              PARTITION BY thread_id, provider, session_id, scope
              ORDER BY CASE WHEN sequence IS NULL THEN 0 ELSE 1 END, sequence, created_at, activity_id
            ) AS previous_total
            FROM consumption_ranked WHERE rank = 1
          )
        ),
        legacy_delta AS (
          SELECT * FROM cumulative_delta
          UNION ALL SELECT * FROM used_only_delta
        ),
        live_tokens AS (
          SELECT created_at, provider, model, tokens, 0 AS estimated
          FROM consumption_delta
          WHERE dispatch_origin IS NULL OR dispatch_origin = 'user'
          UNION ALL
          SELECT day AS created_at, provider, model, d AS tokens, 1 AS estimated
          FROM legacy_delta l
          WHERE (dispatch_origin IS NULL OR dispatch_origin = 'user')
            AND NOT EXISTS (
              SELECT 1 FROM consumption_raw c
              WHERE c.thread_id = l.thread_id AND c.provider = l.provider
                AND (c.turn_id = l.turn_id OR c.created_at <= l.day)
            )
        )
  `;
}
