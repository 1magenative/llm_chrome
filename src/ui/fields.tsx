import { useEffect, useState } from 'preact/hooks';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'url' | 'password';
  placeholder?: string;
  list?: string;
}

export function TextField({ label, value, onChange, type = 'text', placeholder, list }: TextFieldProps) {
  return (
    <label class="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        list={list}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => onChange(e.currentTarget.value)}
      />
    </label>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

/** Числовое поле с локальной строкой, чтобы можно было стереть значение при наборе. */
export function NumberField({ label, value, onChange, min, max, step = 1 }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  // Синхронизируемся только при внешнем изменении значения.
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
  }, [value]);

  return (
    <label class="field">
      <span>{label}</span>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        onInput={(e) => {
          const t = e.currentTarget.value;
          setText(t);
          const n = Number(t);
          if (t.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

interface CheckFieldProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}

export function CheckField({ label, checked, onChange, hint }: CheckFieldProps) {
  return (
    <label class="check" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      {label}
    </label>
  );
}
