// mobile/app/admin/activities.tsx
// Admin → Activities: read-only overview of every activity (who made it,
// shared or private, status). Teachers make activities; the admin only hides /
// unhides published ones. The screen is shared with teachers: components/activities.

import { ActivityListScreen } from "../../components/activities/ActivityListScreen";

export default function AdminActivities() {
  return <ActivityListScreen area="admin" />;
}
