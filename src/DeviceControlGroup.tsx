import { useEffect, useRef, useState } from "react";

export interface DeviceMenuOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
  tone?: "default" | "primary" | "success" | "warning" | "danger";
}

export interface DeviceHostEditor {
  label: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
  onCommit?: (next: string) => void;
}

export interface DeviceControlGroupProps<
  TComm extends string = string,
  TState extends string = string,
> {
  name: string;
  statusTone: "online" | "idle" | "sleep" | "warn" | "offline" | "accent";
  statusTitle?: string;
  metric?: string | null;
  busy?: boolean;
  commValue: TComm;
  commLabel: string;
  commTone: "usb" | "wifi" | "muted";
  commForced?: boolean;
  commTitle?: string;
  commOptions: DeviceMenuOption<TComm>[];
  onSelectComm: (value: TComm) => void;
  hostEditor?: DeviceHostEditor;
  stateValue: TState;
  stateLabel: string;
  stateLiveLabel: string;
  stateTone: "online" | "idle" | "sleep" | "warn" | "offline" | "accent";
  stateForced?: boolean;
  stateTitle?: string;
  stateOptions: DeviceMenuOption<TState>[];
  onSelectState: (value: TState) => void;
  extraStateAction?: {
    label: string;
    description?: string;
    disabled?: boolean;
    onClick: () => void;
  } | null;
}

type OpenMenu = "comm" | "state" | null;

export function DeviceControlGroup<
  TComm extends string = string,
  TState extends string = string,
>({
  name,
  statusTone,
  statusTitle,
  metric,
  busy = false,
  commValue,
  commLabel,
  commTone,
  commForced = false,
  commTitle,
  commOptions,
  onSelectComm,
  hostEditor,
  stateValue,
  stateLabel,
  stateLiveLabel,
  stateTone,
  stateForced = false,
  stateTitle,
  stateOptions,
  onSelectState,
  extraStateAction,
}: DeviceControlGroupProps<TComm, TState>) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  return (
    <div className="device-pill" ref={rootRef}>
      <span className="device-pill__id" title={statusTitle}>
        <span className={`device-pill__dot is-${statusTone}`} aria-hidden="true" />
        <span className="device-pill__name">{name}</span>
        {metric ? <span className="device-pill__metric">{metric}</span> : null}
      </span>

      <div className="device-pill__slot">
        <button
          type="button"
          className={`device-pill__btn is-comm-${commTone}${commForced ? " is-forced" : ""}${openMenu === "comm" ? " is-open" : ""}`}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={openMenu === "comm"}
          title={commTitle ?? `${name} communication method`}
          onClick={() => setOpenMenu((cur) => (cur === "comm" ? null : "comm"))}
        >
          <span className="device-pill__kicker">COM</span>
          <span className="device-pill__val">{commLabel}</span>
          <span className="device-pill__caret" aria-hidden="true">▾</span>
        </button>

        {openMenu === "comm" && (
          <div className="device-popover" role="menu" aria-label={`${name} communication method`}>
            <div className="device-popover__header">
              <span>{name} Com Method</span>
              <span className="device-popover__hint">{commForced ? "Forced" : "Auto"}</span>
            </div>
            <div className="device-popover__list">
              {commOptions.map((opt) => {
                const selected = opt.value === commValue;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={opt.disabled}
                    className={`device-popover__item${selected ? " is-selected" : ""}${opt.tone ? ` is-tone-${opt.tone}` : ""}`}
                    onClick={() => {
                      setOpenMenu(null);
                      onSelectComm(opt.value);
                    }}
                  >
                    <span className="device-popover__row">
                      <span className="device-popover__check" aria-hidden="true">
                        {selected ? "✓" : ""}
                      </span>
                      <span className="device-popover__label">{opt.label}</span>
                      {opt.badge ? <span className="device-popover__badge">{opt.badge}</span> : null}
                    </span>
                    {opt.description ? (
                      <span className="device-popover__desc">{opt.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {hostEditor && (
              <div className="device-popover__host">
                <label className="device-popover__host-label">{hostEditor.label}</label>
                <input
                  value={hostEditor.value}
                  placeholder={hostEditor.placeholder}
                  onChange={(e) => hostEditor.onChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      hostEditor.onCommit?.(hostEditor.value);
                      setOpenMenu(null);
                    }
                  }}
                  onBlur={() => hostEditor.onCommit?.(hostEditor.value)}
                  aria-label={`${name} ${hostEditor.label}`}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="device-pill__slot">
        <button
          type="button"
          className={`device-pill__btn is-state-${stateTone}${stateForced ? " is-forced" : ""}${openMenu === "state" ? " is-open" : ""}`}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={openMenu === "state"}
          title={stateTitle ?? `${name} state (click to force state)`}
          onClick={() => setOpenMenu((cur) => (cur === "state" ? null : "state"))}
        >
          <span className="device-pill__kicker">STATE</span>
          <span className="device-pill__val">{stateLabel}</span>
          <span className="device-pill__caret" aria-hidden="true">▾</span>
        </button>

        {openMenu === "state" && (
          <div className="device-popover" role="menu" aria-label={`${name} state`}>
            <div className="device-popover__header">
              <span>{name} State</span>
              <span className="device-popover__hint">Live: {stateLiveLabel}</span>
            </div>
            <div className="device-popover__list">
              {stateOptions.map((opt) => {
                const selected = opt.value === stateValue;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={opt.disabled}
                    className={`device-popover__item${selected ? " is-selected" : ""}${opt.tone ? ` is-tone-${opt.tone}` : ""}`}
                    onClick={() => {
                      setOpenMenu(null);
                      onSelectState(opt.value);
                    }}
                  >
                    <span className="device-popover__row">
                      <span className="device-popover__check" aria-hidden="true">
                        {selected ? "✓" : ""}
                      </span>
                      <span className="device-popover__label">{opt.label}</span>
                      {opt.badge ? <span className="device-popover__badge">{opt.badge}</span> : null}
                    </span>
                    {opt.description ? (
                      <span className="device-popover__desc">{opt.description}</span>
                    ) : null}
                  </button>
                );
              })}
              {extraStateAction && (
                <>
                  <div className="device-popover__sep" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={extraStateAction.disabled}
                    className="device-popover__item is-tone-primary"
                    onClick={() => {
                      setOpenMenu(null);
                      extraStateAction.onClick();
                    }}
                  >
                    <span className="device-popover__row">
                      <span className="device-popover__check" aria-hidden="true">↻</span>
                      <span className="device-popover__label">{extraStateAction.label}</span>
                    </span>
                    {extraStateAction.description ? (
                      <span className="device-popover__desc">{extraStateAction.description}</span>
                    ) : null}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
