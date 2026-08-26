import assert from "node:assert/strict";
import test from "node:test";
import {
  AdmissionBlockedError,
  evaluateAdmission,
  requireAdmission
} from "../dist/index.js";

const hold = (overrides = {}) => ({
  id: "hold-1",
  subjectId: "work-1",
  active: true,
  sourceId: "case-1",
  reasonCode: "review_required",
  createdAt: "2026-08-26T00:00:00.000Z",
  ...overrides
});

test("allows admission when matching holds are inactive or outside the operation targets", () => {
  const decision = evaluateAdmission(
    [{ subjectId: "work-1" }],
    [hold({ active: false }), hold({ id: "hold-2", subjectId: "work-2" })]
  );

  assert.deepEqual(decision, {
    allowed: true,
    blockedSubjectIds: [],
    activeHoldReasonCodes: []
  });
});

test("returns stable, de-duplicated hold information for blocked targets", () => {
  const decision = evaluateAdmission(
    [{ subjectId: "work-2" }, { subjectId: "work-1" }, { subjectId: "work-1" }],
    [
      hold({ id: "hold-1", subjectId: "work-1", reasonCode: "review_required" }),
      hold({ id: "hold-2", subjectId: "work-2", reasonCode: "safety_lock" }),
      hold({ id: "hold-3", subjectId: "work-1", reasonCode: "review_required" })
    ]
  );

  assert.deepEqual(decision, {
    allowed: false,
    blockedSubjectIds: ["work-1", "work-2"],
    activeHoldReasonCodes: ["review_required", "safety_lock"]
  });
});

test("throws a typed error when admission is required", () => {
  assert.throws(
    () => requireAdmission([{ subjectId: "work-1" }], [hold()], "publish.work"),
    (error) => error instanceof AdmissionBlockedError
      && error.message === "publish.work is blocked by an active review hold."
      && error.decision.allowed === false
  );
});
