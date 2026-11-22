-- Some early installations ran draft versions of migrations 0034 and 0036
-- that populated legacy tokens with nil UUIDs. Host rejects those tokens, so
-- they could never identify an accepted approval or withdrawal. Repair only
-- the nil fields, preserving pending withdrawals and any non-nil tokens. SCIM
-- also journals the selected incarnation. Translate a pending journal target
-- only when that organization/principal still has the nil incarnation: a
-- removed or replaced membership must never be mistaken for the old target.
WITH targets AS (
  SELECT users."id", target.value, target.ordinality,
         target.value->'completed' = 'false'::jsonb
           AND jsonb_typeof(target.value->'principalId') = 'string'
           AND target.value->>'incarnation' = '00000000-0000-0000-0000-000000000000'
           AND EXISTS (
             SELECT 1 FROM "organization_memberships" AS membership
             WHERE membership."organization_id" = users."organization_id"
               AND membership."principal_id" = target.value->>'principalId'
               AND membership."incarnation" = '00000000-0000-0000-0000-000000000000'::uuid
           ) AS repair
  FROM "scim_users" AS users
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(users."raw"->'urn:opensesame:params:scim:2.0:deprovision-journal'->'targets') = 'array'
      THEN users."raw"->'urn:opensesame:params:scim:2.0:deprovision-journal'->'targets'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS target(value, ordinality)
  WHERE EXISTS (
    SELECT 1 FROM "organization_memberships"
    WHERE "incarnation" = '00000000-0000-0000-0000-000000000000'::uuid
  )
), repaired AS (
  SELECT "id", jsonb_agg(
           CASE WHEN repair THEN jsonb_set(value, '{incarnation}', '"00000000-0000-4000-8000-000000000001"'::jsonb)
                ELSE value END ORDER BY ordinality
         ) AS targets
  FROM targets
  GROUP BY "id"
  HAVING bool_or(repair)
)
UPDATE "scim_users" AS users
SET "raw" = jsonb_set(users."raw", ARRAY['urn:opensesame:params:scim:2.0:deprovision-journal', 'targets'], repaired.targets)
FROM repaired
WHERE users."id" = repaired."id";
--> statement-breakpoint
-- Normal upgrades already use non-nil sentinels and do not rewrite rows here.
UPDATE "organization_memberships"
SET "incarnation" = CASE
      WHEN "incarnation" = '00000000-0000-0000-0000-000000000000'::uuid
      THEN '00000000-0000-4000-8000-000000000001'::uuid
      ELSE "incarnation"
    END,
    "authority_revision" = CASE
      WHEN "authority_revision" = '00000000-0000-0000-0000-000000000000'::uuid
      THEN '00000000-0000-4000-8000-000000000002'::uuid
      ELSE "authority_revision"
    END
WHERE "incarnation" = '00000000-0000-0000-0000-000000000000'::uuid
   OR "authority_revision" = '00000000-0000-0000-0000-000000000000'::uuid;
