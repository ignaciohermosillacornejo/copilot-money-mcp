import { z } from 'zod';

export const UserProfileSchema = z
  .object({
    user_id: z.string(),
    budgeting_enabled: z.boolean().optional(),
    authentication_required: z.boolean().optional(),
    data_initialized: z.boolean().optional(),
    onboarding_completed: z.boolean().optional(),
    logged_out: z.boolean().optional(),
    match_internal_txs_enabled: z.boolean().optional(),
    rollovers_enabled: z.boolean().optional(),
    investments_performance_initialized: z.boolean().optional(),
    finance_goals_monthly_summary_mode_enabled: z.boolean().optional(),
    public_id: z.string().optional(),
    last_cold_open: z.string().optional(),
    last_warm_open: z.string().optional(),
    last_month_reviewed: z.string().optional(),
    last_year_reviewed: z.string().optional(),
    account_creation_timestamp: z.string().optional(),
    onboarding_completed_timestamp: z.string().optional(),
    onboarding_last_completed_step: z.string().optional(),
    service_ends_on_ms: z.number().optional(),
    items_disconnect_on_ms: z.number().optional(),
    intelligence_categories_review_count: z.number().optional(),
    accounts_config: z.record(z.string(), z.unknown()).optional(),
    auto_terms_timestamps: z.record(z.string(), z.unknown()).optional(),
    fcm_tokens: z.array(z.string()).optional(),
    finance_goals_review_timestamps: z.record(z.string(), z.unknown()).optional(),
    latest_spending_trigger: z.string().optional(),
    ml_report: z.record(z.string(), z.unknown()).optional(),
    notifications: z.record(z.string(), z.unknown()).optional(),
    rollovers_starte_date: z.string().optional(), // typo in Firestore — kept intentionally
    terms_timestamps: z.record(z.string(), z.unknown()).optional(),
    _origin: z.string().optional(),
  })
  .passthrough();

export type UserProfile = z.infer<typeof UserProfileSchema>;
