// Single source of truth lives in src/shared.ts, which the pipeline's /ai
// feed builder (src/ai.ts) also reads — a second copy here is exactly how the
// site and that feed would end up disagreeing about a category's slug.
import { catShortName, catToSlug } from "@dothingslol/core/shared";

export { catShortName, catToSlug };
