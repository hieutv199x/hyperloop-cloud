export class SchedulerMetrics {
  slotsUsed = 0;
  slotsAvailable = 0;
  queueDepth = 0;
  jobPending = 0;
  jobRunning = 0;
  reservationReconciliationTotal = 0;
  schedulerDispatchFailuresTotal = 0;
  busyPollSuppressedTotal = 0;

  snapshot() {
    return {
      hyperloop_slots_used: this.slotsUsed,
      hyperloop_slots_available: this.slotsAvailable,
      hyperloop_queue_depth: this.queueDepth,
      hyperloop_job_pending: this.jobPending,
      hyperloop_job_running: this.jobRunning,
      hyperloop_reservation_reconciliation_total: this.reservationReconciliationTotal,
      hyperloop_scheduler_dispatch_failures_total: this.schedulerDispatchFailuresTotal,
      hyperloop_busy_poll_suppressed_total: this.busyPollSuppressedTotal,
    };
  }
}
