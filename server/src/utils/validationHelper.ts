/**
 * Generic validation utilities for date ranges and common constraints.
 * Provides reusable validation logic to reduce redundancy across services.
 */

export interface ValidationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ValidationException extends Error {
  constructor(
    public readonly errors: ValidationError[],
  ) {
    super(
      errors.map((e) => e.message).join("; "),
    );
    this.name = "ValidationException";
  }
}

/**
 * Validates date range with comprehensive error reporting.
 * @throws ValidationException with specific error codes
 */
export function validateDateRange(
  startDate: Date,
  endDate: Date,
  options: {
    maxWindowDays?: number;
    allowFutureDates?: boolean;
    minWindowDays?: number;
  } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const {
    maxWindowDays = 730, // 2 years default
    allowFutureDates = false,
    minWindowDays = 1,
  } = options;

  const now = new Date();

  // Check for future dates
  if (!allowFutureDates) {
    if (startDate > now) {
      errors.push({
        code: "DATE_IN_FUTURE",
        message: `Start date (${startDate.toISOString()}) cannot be in the future`,
        details: { provided: startDate, now },
      });
    }

    if (endDate > now) {
      errors.push({
        code: "DATE_IN_FUTURE",
        message: `End date (${endDate.toISOString()}) cannot be in the future`,
        details: { provided: endDate, now },
      });
    }
  }

  // Check date order
  if (startDate >= endDate) {
    errors.push({
      code: "INVALID_DATE_ORDER",
      message: `Start date (${startDate.toISOString()}) must be before end date (${endDate.toISOString()})`,
      details: { startDate, endDate },
    });
  }

  // Check window size
  const windowDays = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (windowDays > maxWindowDays) {
    errors.push({
      code: "DATE_WINDOW_TOO_LARGE",
      message: `Date range (${windowDays} days) exceeds maximum of ${maxWindowDays} days`,
      details: { windowDays, maxWindowDays },
    });
  }

  if (windowDays < minWindowDays) {
    errors.push({
      code: "DATE_WINDOW_TOO_SMALL",
      message: `Date range (${windowDays} days) is less than minimum of ${minWindowDays} day(s)`,
      details: { windowDays, minWindowDays },
    });
  }

  return errors;
}

/**
 * Validates numeric range with constraints.
 */
export function validateNumericRange(
  value: number,
  options: {
    min?: number;
    max?: number;
    name?: string;
  } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const { min, max, name = "value" } = options;

  if (min !== undefined && value < min) {
    errors.push({
      code: "VALUE_BELOW_MINIMUM",
      message: `${name} (${value}) is below minimum (${min})`,
      details: { value, min, name },
    });
  }

  if (max !== undefined && value > max) {
    errors.push({
      code: "VALUE_ABOVE_MAXIMUM",
      message: `${name} (${value}) exceeds maximum (${max})`,
      details: { value, max, name },
    });
  }

  return errors;
}

/**
 * Validates that required fields are present.
 */
export function validateRequired(
  obj: Record<string, unknown>,
  requiredFields: string[],
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === "") {
      errors.push({
        code: "FIELD_REQUIRED",
        message: `Field '${field}' is required`,
        details: { field },
      });
    }
  }

  return errors;
}

/**
 * Aggregates multiple validation error arrays and throws if any errors exist.
 */
export function throwIfErrors(
  ...errorArrays: ValidationError[][]
): void {
  const allErrors = errorArrays.flat();
  if (allErrors.length > 0) {
    throw new ValidationException(allErrors);
  }
}

/**
 * Safely executes validation and returns errors instead of throwing.
 */
export function collectValidationErrors(
  validators: Array<() => ValidationError[]>,
): ValidationError[] {
  return validators.flatMap((fn) => fn());
}
