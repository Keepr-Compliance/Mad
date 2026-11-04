/**
 * The plan name shown to the user (moved out of Profile, BACKLOG-3964).
 *
 * ONE helper for every surface that names the plan: the Account tab today,
 * the account side panel in slice 3. BACKLOG-3864 changes the license value
 * this reads; routing every label through here means that change shows
 * everywhere without editing any surface.
 */
export function formatPlanLabel(type: string): string {
  switch (type) {
    case "individual":
      return "Individual";
    case "team":
      return "Team";
    case "enterprise":
      return "Enterprise";
    default:
      return type ? type.charAt(0).toUpperCase() + type.slice(1) : "";
  }
}
