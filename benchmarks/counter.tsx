// [xihanzu-NR]
import React, { useState, useEffect } from 'react';

export function Counter({ initialCount = 0, step = 1 }: CounterProps) {
  const [count, setCount] = useState<number>(initialCount);

  useEffect(() => {
    console.log(`count ${count}`);
  }, [count]);

  return (
    <div className="counter-card">
      <h2>Value: {count}</h2>
      <div className="button-group">
        <button type="button" onClick={() => setCount(count - step)} className="btn btn-secondary">
          -
        </button>
        <button type="button" onClick={() => setCount(count + step)} className="btn btn-primary">
          +
        </button>
      </div>
    </div>
  );
}

interface CounterProps {
  initialCount?: number;
  step?: number;
}
