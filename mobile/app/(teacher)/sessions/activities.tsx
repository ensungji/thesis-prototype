// mobile/app/(teacher)/sessions/activities.tsx
// Teacher → Activities: Mine (their own, private) and Shared (the admin's,
// read-only). Opened from the Sessions list and New Session › Activity.

import { ActivityListScreen } from "../../../components/activities/ActivityListScreen";

export default function TeacherActivities() {
  return <ActivityListScreen area="teacher" />;
}
