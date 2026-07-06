// UX1 interview webview entry (#46) — mounts the live interview view.
import { applyBrandAccent } from "../media/ui/brand_accent";
import { createInterview } from "../media/ui/views/interview";

applyBrandAccent();   // theme-calculated Harmoniqs yellow (brand-wide contract)
document.body.append(createInterview().el);
