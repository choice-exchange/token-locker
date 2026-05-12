use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Timestamp, Uint128, Uint256};

use crate::error::ContractError;

/// Hard cap on the number of breakpoints in a `PiecewiseLinear` schedule.
/// Bounds storage cost per lock and gas cost on pagination queries (every lock
/// row decodes its schedule in full).
pub const MAX_PIECEWISE_STEPS: usize = 50;

/// How a lock becomes claimable over time.
///
/// `claimable_at(t, total)` returns the cumulative amount unlocked at time `t`.
/// `Withdraw` releases `claimable_at(now, total) - withdrawn`.
///
/// `Cliff` is the only schedule that supports `TopUp` and `Extend`. The vesting
/// variants are immutable once created — top-up semantics on a vesting curve are
/// ambiguous (should the new funds back-vest, or vest going forward?), so we
/// don't try to pick.
#[cw_serde]
pub enum Schedule {
    /// All-or-nothing at `unlock_at`. Top-up and Extend allowed.
    Cliff { unlock_at: Timestamp },

    /// Linear vest from `start_at` (0%) to `end_at` (100%). Reverts before
    /// `start_at`; saturates at `total` after `end_at`. Immutable.
    SaturatingLinear { start_at: Timestamp, end_at: Timestamp },

    /// Piecewise-linear interpolation between sorted `(time, cumulative)`
    /// breakpoints. The final amount must equal the lock's `total`.
    /// Immutable.
    PiecewiseLinear { steps: Vec<(Timestamp, Uint128)> },
}

impl Schedule {
    /// Validate the schedule against a `now` baseline and the lock's `total` amount.
    pub fn validate(&self, now: Timestamp, total: Uint128) -> Result<(), ContractError> {
        if total.is_zero() {
            return Err(ContractError::ZeroAmount {});
        }
        match self {
            Schedule::Cliff { unlock_at } => {
                if unlock_at.seconds() <= now.seconds() {
                    return Err(ContractError::UnlockNotInFuture {});
                }
            }
            Schedule::SaturatingLinear { start_at, end_at } => {
                if end_at.seconds() <= start_at.seconds() {
                    return Err(ContractError::InvalidSchedule(
                        "end_at must be after start_at".into(),
                    ));
                }
                if end_at.seconds() <= now.seconds() {
                    return Err(ContractError::UnlockNotInFuture {});
                }
            }
            Schedule::PiecewiseLinear { steps } => {
                if steps.is_empty() {
                    return Err(ContractError::InvalidSchedule("steps cannot be empty".into()));
                }
                if steps.len() > MAX_PIECEWISE_STEPS {
                    return Err(ContractError::PiecewiseTooManySteps {
                        max: MAX_PIECEWISE_STEPS,
                        got: steps.len(),
                    });
                }
                let mut last_t = 0u64;
                let mut last_a = Uint128::zero();
                for (i, (t, a)) in steps.iter().enumerate() {
                    if i == 0 {
                        if t.seconds() < now.seconds() {
                            return Err(ContractError::InvalidSchedule(
                                "first step is in the past".into(),
                            ));
                        }
                    } else if t.seconds() <= last_t {
                        return Err(ContractError::InvalidSchedule(
                            "step timestamps must strictly increase".into(),
                        ));
                    }
                    if a < &last_a {
                        return Err(ContractError::InvalidSchedule(
                            "step amounts must be non-decreasing".into(),
                        ));
                    }
                    last_t = t.seconds();
                    last_a = *a;
                }
                if last_a != total {
                    return Err(ContractError::InvalidSchedule(
                        "final step amount must equal lock total".into(),
                    ));
                }
                if last_t <= now.seconds() {
                    return Err(ContractError::UnlockNotInFuture {});
                }
            }
        }
        Ok(())
    }

    /// Last timestamp at which any portion of the lock is still pending.
    pub fn final_unlock_at(&self) -> Timestamp {
        match self {
            Schedule::Cliff { unlock_at } => *unlock_at,
            Schedule::SaturatingLinear { end_at, .. } => *end_at,
            Schedule::PiecewiseLinear { steps } => {
                steps.last().map(|(t, _)| *t).unwrap_or_else(|| Timestamp::from_seconds(0))
            }
        }
    }

    /// Cumulative claimable amount at time `t`, given lock `total`.
    pub fn claimable_at(&self, t: Timestamp, total: Uint128) -> Uint128 {
        let now = t.seconds();
        match self {
            Schedule::Cliff { unlock_at } => {
                if now >= unlock_at.seconds() {
                    total
                } else {
                    Uint128::zero()
                }
            }
            Schedule::SaturatingLinear { start_at, end_at } => {
                if now <= start_at.seconds() {
                    return Uint128::zero();
                }
                if now >= end_at.seconds() {
                    return total;
                }
                let elapsed = now - start_at.seconds();
                let span = end_at.seconds() - start_at.seconds();
                lerp(total, elapsed, span)
            }
            Schedule::PiecewiseLinear { steps } => {
                let first = &steps[0];
                if now <= first.0.seconds() {
                    return Uint128::zero();
                }
                let last = steps.last().unwrap();
                if now >= last.0.seconds() {
                    return total;
                }
                // find the interval [steps[i-1], steps[i]] containing now
                for i in 1..steps.len() {
                    let (t1, a1) = steps[i];
                    if now < t1.seconds() {
                        let (t0, a0) = steps[i - 1];
                        let span = t1.seconds() - t0.seconds();
                        let elapsed = now - t0.seconds();
                        let delta = a1 - a0;
                        return a0 + lerp(delta, elapsed, span);
                    }
                }
                total
            }
        }
    }

    pub fn is_cliff(&self) -> bool {
        matches!(self, Schedule::Cliff { .. })
    }
}

/// `total * num / den` using Uint256 to avoid overflow.
fn lerp(total: Uint128, num: u64, den: u64) -> Uint128 {
    if den == 0 {
        return Uint128::zero();
    }
    let scaled = Uint256::from(total) * Uint256::from(num) / Uint256::from(den);
    Uint128::try_from(scaled).expect("lerp result fits in Uint128 because total does")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(s: u64) -> Timestamp {
        Timestamp::from_seconds(s)
    }

    #[test]
    fn cliff_claimable() {
        let s = Schedule::Cliff { unlock_at: ts(100) };
        assert_eq!(s.claimable_at(ts(99), Uint128::new(1000)), Uint128::zero());
        assert_eq!(s.claimable_at(ts(100), Uint128::new(1000)), Uint128::new(1000));
        assert_eq!(s.claimable_at(ts(500), Uint128::new(1000)), Uint128::new(1000));
    }

    #[test]
    fn linear_claimable() {
        let s = Schedule::SaturatingLinear { start_at: ts(100), end_at: ts(200) };
        assert_eq!(s.claimable_at(ts(50), Uint128::new(1000)), Uint128::zero());
        assert_eq!(s.claimable_at(ts(100), Uint128::new(1000)), Uint128::zero());
        assert_eq!(s.claimable_at(ts(150), Uint128::new(1000)), Uint128::new(500));
        assert_eq!(s.claimable_at(ts(200), Uint128::new(1000)), Uint128::new(1000));
        assert_eq!(s.claimable_at(ts(999), Uint128::new(1000)), Uint128::new(1000));
    }

    #[test]
    fn piecewise_claimable() {
        let s = Schedule::PiecewiseLinear {
            steps: vec![
                (ts(100), Uint128::zero()),
                (ts(200), Uint128::new(250)),
                (ts(400), Uint128::new(1000)),
            ],
        };
        assert_eq!(s.claimable_at(ts(50), Uint128::new(1000)), Uint128::zero());
        assert_eq!(s.claimable_at(ts(100), Uint128::new(1000)), Uint128::zero());
        assert_eq!(s.claimable_at(ts(150), Uint128::new(1000)), Uint128::new(125));
        assert_eq!(s.claimable_at(ts(200), Uint128::new(1000)), Uint128::new(250));
        assert_eq!(s.claimable_at(ts(300), Uint128::new(1000)), Uint128::new(625));
        assert_eq!(s.claimable_at(ts(400), Uint128::new(1000)), Uint128::new(1000));
        assert_eq!(s.claimable_at(ts(9999), Uint128::new(1000)), Uint128::new(1000));
    }

    #[test]
    fn validate_rejects_past_unlock() {
        let s = Schedule::Cliff { unlock_at: ts(100) };
        assert!(s.validate(ts(100), Uint128::new(1)).is_err());
        assert!(s.validate(ts(99), Uint128::new(1)).is_ok());
    }

    #[test]
    fn validate_rejects_piecewise_total_mismatch() {
        let s = Schedule::PiecewiseLinear {
            steps: vec![(ts(100), Uint128::zero()), (ts(200), Uint128::new(999))],
        };
        assert!(s.validate(ts(0), Uint128::new(1000)).is_err());
    }

    #[test]
    fn validate_rejects_piecewise_step_bomb() {
        // MAX_PIECEWISE_STEPS + 1 steps with a coherent ramp to total
        let n = MAX_PIECEWISE_STEPS + 1;
        let total = n as u128 * 10;
        let mut steps = Vec::with_capacity(n);
        for i in 1..=n {
            steps.push((ts(i as u64 * 100), Uint128::new(i as u128 * 10)));
        }
        let s = Schedule::PiecewiseLinear { steps };
        assert!(matches!(
            s.validate(ts(0), Uint128::new(total)),
            Err(ContractError::PiecewiseTooManySteps { .. })
        ));
    }

    #[test]
    fn final_unlock_at_matches_schedule_end() {
        assert_eq!(
            Schedule::Cliff { unlock_at: ts(500) }.final_unlock_at().seconds(),
            500
        );
        assert_eq!(
            Schedule::SaturatingLinear { start_at: ts(100), end_at: ts(500) }
                .final_unlock_at()
                .seconds(),
            500
        );
        assert_eq!(
            Schedule::PiecewiseLinear {
                steps: vec![(ts(100), Uint128::zero()), (ts(500), Uint128::new(1000))],
            }
            .final_unlock_at()
            .seconds(),
            500
        );
    }
}
