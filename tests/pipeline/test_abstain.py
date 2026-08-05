from __future__ import annotations

from wordless.pipeline.abstain import (
    calibrate_and_evaluate,
    calibrate_threshold,
    risk_coverage_curve,
)


def test_risk_coverage_curve_carries_all_counts() -> None:
    curve = risk_coverage_curve([0.9, 0.8, 0.7, 0.6], [True, True, False, True])

    assert curve[0].selected_count == 0
    assert curve[0].denominator == 4
    assert curve[-1].coverage == 1.0
    assert curve[-1].correct_count == 3
    assert curve[-1].error_count == 1
    assert curve[-1].risk == 0.25


def test_calibration_maximizes_coverage_at_target_precision() -> None:
    fitted = calibrate_threshold(
        [0.95, 0.90, 0.70, 0.60],
        [True, True, False, True],
        target_precision=0.8,
    )

    assert fitted.achieved is True
    assert fitted.threshold == 0.9
    assert fitted.selected_count == 2
    assert fitted.denominator == 4
    assert fitted.precision == 1.0


def test_threshold_is_frozen_before_held_out_evaluation() -> None:
    result = calibrate_and_evaluate(
        [0.9, 0.8, 0.7],
        [True, True, False],
        [0.85, 0.75, 0.65],
        [True, False, False],
        target_precision=1.0,
    )

    assert result.calibration.threshold == 0.8
    assert result.held_out.threshold == result.calibration.threshold
    assert result.held_out.denominator == 3
    assert result.held_out.selected_count == 1
