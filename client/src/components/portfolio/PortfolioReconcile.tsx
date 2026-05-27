import React from 'react';
import './PortfolioReconcile.css';
import type { ReconcileRow } from '../../../server/src/services/portfolioReconcileService';

type Props = { rows: ReconcileRow[] };

export const PortfolioReconcile: React.FC<Props> = ({ rows }) => {
  return (
    <div className="portfolio-reconcile">
      <table>
        <thead>
          <tr>
            <th>Asset</th>
            <th>Expected</th>
            <th>Observed</th>
            <th>Delta</th>
            <th>Severity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.asset} className={`sev-${r.severity}`}>
              <td>{r.asset}</td>
              <td>{r.expected}</td>
              <td>{r.observed === null ? '—' : r.observed}</td>
              <td>{r.delta === null ? '—' : r.delta}</td>
              <td>{r.severity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default PortfolioReconcile;
