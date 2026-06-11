/**
 * Copilot `ColorName` GraphQL enum (uppercase wire form).
 *
 * Shared by tags (CreateTagInput/EditTagInput.colorName) and categories
 * (CreateCategoryInput/EditCategoryInput.colorName) — kept in its own module
 * so neither domain file owns the other's enum.
 *
 * Value set discovered via error-leak harvesting against production
 * (issue #439): every `<BASE><N>` candidate over a 40-base palette was
 * probed with a validation-only query, and the server's "Did you mean"
 * suggestions converged on exactly these 16 values — note the asymmetry
 * (ORANGE/PINK/PURPLE/RED/YELLOW have a *2 variant; BLUE/BROWN/GRAY/GREEN/
 * OLIVE/TEAL do not). Single source of truth for the create_tag/update_tag/
 * create_category/update_category validation + schema enums; conformance is
 * re-verified on every smoke run (scripts/smoke/conformance.ts).
 */
export const COLOR_NAMES = [
  'BLUE1',
  'BROWN1',
  'GRAY1',
  'GREEN1',
  'OLIVE1',
  'ORANGE1',
  'ORANGE2',
  'PINK1',
  'PINK2',
  'PURPLE1',
  'PURPLE2',
  'RED1',
  'RED2',
  'TEAL1',
  'YELLOW1',
  'YELLOW2',
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];
