// mobile/app/(teacher)/sessions/activities.tsx
// Teacher → Activities: Mine (their own: drafts private, published ones shared
// or not) and Shared (other teachers' shared published ones, read-only).
// Opened from the Sessions list and New Session › Activity.

import { ActivityListScreen } from "../../../components/activities/ActivityListScreen";

export default function TeacherActivities() {
  return <ActivityListScreen area="teacher" />;
}
