interface Props {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    decimals?: number;
    suffix?: React.ReactNode;
    helper?: React.ReactNode;
}

export function AmountInput({ label, value, onChange, placeholder, suffix, helper }: Props) {
    return (
        <div>
            <label>{label}</label>
            <div className="relative">
                <input
                    type="text"
                    inputMode="decimal"
                    pattern="^\d*\.?\d*$"
                    placeholder={placeholder ?? "0.00"}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className="pr-16 font-mono"
                />
                {suffix && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-200 font-mono">
                        {suffix}
                    </div>
                )}
            </div>
            {helper && <div className="text-xs text-ink-300 mt-1">{helper}</div>}
        </div>
    );
}
