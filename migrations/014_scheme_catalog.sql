-- The government scheme catalog grows from five hand-written entries to the schemes in the
-- official guides (PM-KISAN, PMFBY, Maharashtra agriculture schemes, Ministry schemes).
--
--  * sector / level / audience: how the app groups and filters them.
--  * components: the individual kinds of help inside one programme, with amounts.
--  * rules: machine-checkable eligibility rules, run against what the farmer told us once
--    (land size and farmer_details). The server evaluates them; see schemeEligibility.js.
ALTER TABLE schemes DROP CONSTRAINT schemes_category_check;
ALTER TABLE schemes ADD CONSTRAINT schemes_category_check
  CHECK (category IN ('incomeSupport','insurance','subsidy','creditSupport','training','marketing','livestock','processing'));

ALTER TABLE schemes
  ADD COLUMN level         text  NOT NULL DEFAULT 'central' CHECK (level IN ('central','state')),
  ADD COLUMN sector        text  NOT NULL DEFAULT 'General',
  ADD COLUMN audience      text  NOT NULL DEFAULT 'farmer' CHECK (audience IN ('farmer','group','enterprise')),
  ADD COLUMN components    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN rules         jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN how_to_apply  text  NOT NULL DEFAULT '',
  ADD COLUMN contact       text  NOT NULL DEFAULT '',
  ADD COLUMN website       text  NOT NULL DEFAULT '',
  ADD COLUMN source        text  NOT NULL DEFAULT '';

CREATE INDEX schemes_sector_idx ON schemes (sector);
