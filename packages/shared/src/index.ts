export type UserRole = "owner" | "staff" | "trainer" | "member";

export type FollowUpOutcome =
  | "will_return"
  | "injured"
  | "travelling"
  | "timing_issue"
  | "unhappy"
  | "no_response"
  | "cancelled";

export interface MemberSummary {
  id: string;
  name: string;
  email: string;
  phone: string;
  membershipStatus: "active" | "paused" | "frozen" | "expired" | "cancelled";
  membershipExpiresAt: string;
  lastAttendanceAt?: string;
  absentDays: number;
}

export interface RetentionCaseSummary {
  id: string;
  member: MemberSummary;
  absentDays: number;
  priority: "high" | "medium" | "low";
  status: "open" | "resolved";
  nextActionAt?: string;
}

export interface DashboardSummary {
  activeMembers: number;
  checkInsToday: number;
  openRetentionCases: number;
  revenueThisMonth: number;
  activityRate7d: number;
  recoveryRate: number;
  renewalRate: number;
  recentAttendance: Array<{
    memberName: string;
    checkedInAt: string;
  }>;
}
