import type { GymConfig } from '../../config/gym.js';
import type { Lead } from '../../repositories/leads.js';
import type { Member, Membership, Payment } from '../../repositories/members.js';
import { diffDays, formatHumanDate, formatHumanDateTime, localDate } from '../../utils/dates.js';
import { formatMoney } from '../../utils/format.js';

export const GYM_INFO_TOPICS = [
  'all',
  'contact_and_location',
  'timings',
  'facilities',
  'membership_plans',
  'personal_training',
  'trial',
  'policies',
  'faqs',
] as const;
export type GymInfoTopic = (typeof GYM_INFO_TOPICS)[number];

export function plansView(config: GymConfig) {
  return config.plans.map((p) => ({
    code: p.code,
    name: p.name,
    price: formatMoney(p.price, config),
    billedEvery: p.durationMonths === 1 ? 'month' : `${p.durationMonths} months`,
    description: p.description,
    includes: p.includes,
  }));
}

/** Returns only facts from the gym config. The agent must not state anything outside of this. */
export function gymInformation(config: GymConfig, topic: GymInfoTopic = 'all') {
  const sections = {
    contact_and_location: { ...config.gym },
    timings: { timings: config.timings, holidays: config.holidays ?? null },
    facilities: config.facilities,
    membership_plans: {
      plans: plansView(config),
      joiningFee: config.joiningFee !== undefined ? formatMoney(config.joiningFee, config) : null,
    },
    personal_training: config.personalTraining
      ? {
          ...config.personalTraining,
          packages: config.personalTraining.packages.map((p) => ({ ...p, price: formatMoney(p.price, config) })),
        }
      : { available: false },
    trial: {
      ...config.trial,
      price: config.trial.price === 0 ? 'free' : formatMoney(config.trial.price, config),
      closedWeekdays: config.trial.closedWeekdays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]),
    },
    policies: config.policies,
    faqs: config.faqs,
  };
  return topic === 'all' ? sections : { [topic]: sections[topic] };
}

export function leadView(lead: Lead, config: GymConfig) {
  return {
    stage: lead.stage,
    name: lead.name,
    fitnessGoal: lead.fitness_goal,
    preferredPlan: lead.preferred_plan,
    preferredJoinDate: lead.preferred_join_date,
    trialInterest: lead.trial_interest,
    trialAt: lead.trial_at ? formatHumanDateTime(lead.trial_at, config.timezone, config.currency.locale) : null,
    notes: lead.notes,
    createdAt: localDate(config.timezone, lead.created_at),
  };
}

export function paymentView(p: Payment, config: GymConfig, now: Date) {
  const today = localDate(config.timezone, now);
  const daysUntilDue = diffDays(p.due_date, today);
  return {
    amount: formatMoney(p.amount, config),
    dueDate: p.due_date,
    dueDateText: formatHumanDate(p.due_date, config.currency.locale),
    status: p.status === 'PENDING' ? (daysUntilDue < 0 ? 'OVERDUE' : daysUntilDue === 0 ? 'DUE_TODAY' : 'UPCOMING') : p.status,
    daysOverdue: p.status === 'PENDING' && daysUntilDue < 0 ? -daysUntilDue : undefined,
    paidAmount: p.paid_amount !== null ? formatMoney(p.paid_amount, config) : undefined,
    paidOn: p.paid_at ? localDate(config.timezone, p.paid_at) : undefined,
  };
}

export function memberView(
  member: Member,
  membership: Membership | null,
  outstanding: Payment | null,
  config: GymConfig,
  now: Date,
) {
  return {
    name: member.name,
    status: member.status,
    plan: membership?.plan_name ?? null,
    startDate: membership?.start_date ?? null,
    expiryDate: membership?.expiry_date ?? null,
    monthlyFee: membership ? formatMoney(membership.monthly_fee, config) : null,
    autoRenew: membership?.auto_renew ?? null,
    nextPayment: outstanding ? paymentView(outstanding, config, now) : null,
    paymentStatus: outstanding ? paymentView(outstanding, config, now).status : 'NO_PAYMENT_PENDING',
  };
}
