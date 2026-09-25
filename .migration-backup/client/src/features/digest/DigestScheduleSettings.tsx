import React, { useState, useEffect } from "react";
import { Clock, Calendar, MapPin, AlertCircle, CheckCircle } from "lucide-react";

interface Schedule {
  timezone: string;
  weekday: number;
  hour: number;
  minute: number;
}

interface DigestScheduleSettingsProps {
  walletAddress: string;
  onSave?: (schedule: Schedule) => void;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const DigestScheduleSettings: React.FC<DigestScheduleSettingsProps> = ({
  walletAddress,
  onSave,
}) => {
  const [schedule, setSchedule] = useState<Schedule>({
    timezone: "UTC",
    weekday: 1,
    hour: 9,
    minute: 0,
  });

  const [timezones, setTimezones] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Load timezones on mount
  useEffect(() => {
    async function loadTimezones() {
      try {
        const response = await fetch("/api/digest/schedule/timezones?common=false");
        if (response.ok) {
          const data = await response.json();
          setTimezones(data.timezones || []);
        }
      } catch (err) {
        console.error("Failed to load timezones:", err);
      }
    }

    loadTimezones();
  }, []);

  // Load current schedule
  useEffect(() => {
    async function loadSchedule() {
      try {
        const response = await fetch(`/api/digest/schedule/${walletAddress}`);
        if (response.ok) {
          const data = await response.json();
          if (data.schedule) {
            setSchedule(data.schedule);
          }
        }
      } catch (err) {
        console.error("Failed to load schedule:", err);
      }
    }

    if (walletAddress) {
      loadSchedule();
    }
  }, [walletAddress]);

  const handleChange = (field: keyof Schedule, value: string | number) => {
    setSchedule((prev) => ({
      ...prev,
      [field]: field === "timezone" ? value : Number(value),
    }));
    setValidationErrors((prev) => ({
      ...prev,
      [field]: "",
    }));
  };

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    setSuccess(false);
    setValidationErrors({});

    try {
      const response = await fetch(`/api/digest/schedule/${walletAddress}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule),
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.errors && Array.isArray(data.errors)) {
          const errors: Record<string, string> = {};
          for (const err of data.errors) {
            errors[err.field] = err.message;
          }
          setValidationErrors(errors);
          setError("Please fix the validation errors below.");
        } else {
          setError(data.error || "Failed to save schedule");
        }
        return;
      }

      setSuccess(true);
      if (onSave) {
        onSave(schedule);
      }

      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An error occurred while saving"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-panel p-6 space-y-6 max-w-2xl">
      <h2 className="text-2xl font-bold">Weekly Digest Schedule</h2>

      {/* Timezone Field */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          <MapPin className="w-4 h-4" />
          Timezone
        </label>
        <select
          value={schedule.timezone}
          onChange={(e) => handleChange("timezone", e.target.value)}
          className={`w-full px-4 py-2 rounded-lg bg-gray-900 border transition ${
            validationErrors.timezone
              ? "border-red-500"
              : "border-gray-700 focus:border-blue-500"
          } text-gray-100`}
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        {validationErrors.timezone && (
          <p className="text-sm text-red-400">{validationErrors.timezone}</p>
        )}
      </div>

      {/* Weekday Field */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-200">
          <Calendar className="w-4 h-4" />
          Day of Week
        </label>
        <select
          value={schedule.weekday}
          onChange={(e) => handleChange("weekday", e.target.value)}
          className={`w-full px-4 py-2 rounded-lg bg-gray-900 border transition ${
            validationErrors.weekday
              ? "border-red-500"
              : "border-gray-700 focus:border-blue-500"
          } text-gray-100`}
        >
          {WEEKDAYS.map((day, idx) => (
            <option key={idx} value={idx}>
              {day}
            </option>
          ))}
        </select>
        {validationErrors.weekday && (
          <p className="text-sm text-red-400">{validationErrors.weekday}</p>
        )}
      </div>

      {/* Time Fields */}
      <div className="grid grid-cols-2 gap-4">
        {/* Hour */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-gray-200">
            <Clock className="w-4 h-4" />
            Hour
          </label>
          <input
            type="number"
            min="0"
            max="23"
            value={schedule.hour}
            onChange={(e) => handleChange("hour", e.target.value)}
            className={`w-full px-4 py-2 rounded-lg bg-gray-900 border transition ${
              validationErrors.hour
                ? "border-red-500"
                : "border-gray-700 focus:border-blue-500"
            } text-gray-100`}
          />
          {validationErrors.hour && (
            <p className="text-sm text-red-400">{validationErrors.hour}</p>
          )}
        </div>

        {/* Minute */}
        <div className="space-y-2">
          <label className="text-sm font-semibold text-gray-200">Minute</label>
          <input
            type="number"
            min="0"
            max="59"
            value={schedule.minute}
            onChange={(e) => handleChange("minute", e.target.value)}
            className={`w-full px-4 py-2 rounded-lg bg-gray-900 border transition ${
              validationErrors.minute
                ? "border-red-500"
                : "border-gray-700 focus:border-blue-500"
            } text-gray-100`}
          />
          {validationErrors.minute && (
            <p className="text-sm text-red-400">{validationErrors.minute}</p>
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="bg-gray-900/50 rounded-lg p-4 border border-gray-700">
        <p className="text-sm text-gray-400">
          Your digest will be sent every{" "}
          <span className="font-semibold text-gray-200">{WEEKDAYS[schedule.weekday]}</span> at{" "}
          <span className="font-semibold text-gray-200">
            {String(schedule.hour).padStart(2, "0")}:{String(schedule.minute).padStart(2, "0")}
          </span>{" "}
          <span className="font-semibold text-gray-200">{schedule.timezone}</span>
        </p>
      </div>

      {/* Status Messages */}
      {error && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {success && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/30">
          <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-green-400">Schedule saved successfully!</p>
        </div>
      )}

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={loading}
        className="w-full px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-white transition"
      >
        {loading ? "Saving..." : "Save Schedule"}
      </button>
    </div>
  );
};
