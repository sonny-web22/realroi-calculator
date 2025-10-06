import React, { useState, useEffect, useCallback, useMemo } from 'react';

// --- Helper Icon for Tooltips ---
const InfoIcon = ({ tooltip }) => (
  <span className="tooltip-container">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="info-icon">
      <circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
    <span className="tooltip-text">{tooltip}</span>
  </span>
);

// --- CALCULATION ENGINE ---
const realroi = {
  amortizationSchedule(loan, rateAPR, termYears) {
    const n = termYears * 12;
    let r = rateAPR / 12;
    if (r <= 0) r = 0.0000001;
    const m = (loan * r) / (1 - Math.pow(1 + r, -n));
    let bal = loan;
    const rows = [];
    for (let i = 1; i <= n; i++) {
      const interest = bal * r;
      const principal = m - interest;
      bal -= principal;
      rows.push({ month: i, payment: m, interest, principal, balance: Math.max(0, bal) });
    }
    return { paymentMonthly: m, rows };
  },
  summarizeFinancials(rows, years) {
      const months = Math.min(rows.length, years * 12);
      let principalPaid = 0;
      let interestPaid = 0;
      if (months === 0) return { principalPaid, interestPaid, balance: rows.length > 0 ? rows[0].balance : 0 };
      for (let i = 0; i < months; i++) {
          principalPaid += rows[i].principal;
          interestPaid += rows[i].interest;
      }
      return { principalPaid, interestPaid, balance: rows[months - 1]?.balance ?? 0 };
  },
  appreciationGain(price, rate, years) { return price * (Math.pow(1 + rate, years) - 1); },
  annualCashFlow(cfg) {
    const rentAnnual = cfg.rentMonthly * 12;
    const pm = rentAnnual * cfg.pmPct;
    const taxes = cfg.price * cfg.taxesPct;
    // Vacancy: 1 month's rent every 2 years = 0.5 month's rent per year
    const vacancy = cfg.rentMonthly * 0.5;
    const warranty = cfg.warrantyAnnual;
    const pmi = (cfg.pmiMonthly ?? 0) * 12;
    // Simple repairs placeholder, can be expanded
    const repairs = 15000 / 10;
    return rentAnnual - (cfg.piMonthly * 12 + taxes + cfg.insuranceAnnual + pm + vacancy + repairs + warranty + pmi);
  },
};

// --- MAIN APP COMPONENT ---
export default function App() {
  const DEFAULTS = useMemo(() => ({
    pmPct: 0.08,
    defaultMarginalRate: 0.32,
    pmiAnnualRate: 0.006,
    buildingPct: 0.8, // 80% of property value is the building itself
  }), []);

  const [deal, setDeal] = useState({
    price: 450000,
    downPct: 0.20,
    rate: 6.5,
    termYears: 30,
    taxesPct: 0.017, // Default to 1.70%
    insuranceAnnual: 1800,
    rentMonthly: 2600,
    closingCosts: 8000,
    reserves: 10000,
    fairnessMode: 'matched',
    gainsRate: 0.055, // Renamed from appreciationRate
    timelineYears: 10,
    inflationRate: 0.03, // Default to 3%
    saleCostPct: 0.03, // Realtor fees default to 3%
    etfErBps: 3,
    advisorFee: 0.01, // Default to 1%
    costSegregation: false,
  });
  
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);

  const calculateResults = useCallback(() => {
    setLoading(true);
    const {
      price, downPct, rate, termYears, taxesPct, insuranceAnnual, rentMonthly, closingCosts, reserves,
      fairnessMode, gainsRate, timelineYears, inflationRate, saleCostPct, etfErBps, advisorFee, costSegregation
    } = deal;

    const mergedInputs = { ...DEFAULTS, ...deal };

    const downPayment = price * downPct;
    const loan = price - downPayment;
    const hasPMI = downPct < 0.20;
    const schedule = realroi.amortizationSchedule(loan, rate / 100, termYears);
    
    const principalAndInterest = schedule.paymentMonthly;
    const monthlyTaxes = (price * taxesPct) / 12;
    const monthlyInsurance = insuranceAnnual / 12;
    const piti = principalAndInterest + monthlyTaxes + monthlyInsurance;
    
    // Warranty logic based on timeline
    const warrantyAnnual = (2500 / 5); // $500/yr is consistent

    // Generate a dynamic CPI series based on selected inflation rate
    const monthlyInflation = Math.pow(1 + inflationRate, 1/12) - 1;
    let cpiSeries = [100];
    for(let i=1; i < timelineYears * 12; i++) {
        cpiSeries.push(cpiSeries[i-1] * (1 + monthlyInflation));
    }
    const cpiBase = cpiSeries[0];
    
    const ledger = [];
    for (let y = 1; y <= timelineYears; y++) {
      const financials = realroi.summarizeFinancials(schedule.rows, y);
      const currentLTV = financials.balance / price;
      const pmiMonthly = hasPMI && currentLTV > 0.80 ? (loan * mergedInputs.pmiAnnualRate) / 12 : 0;
      
      const nominalAnnualCashFlow = realroi.annualCashFlow({ ...mergedInputs, piMonthly: schedule.paymentMonthly, pmiMonthly, warrantyAnnual });
      
      const interestThisYear = financials.interestPaid - (ledger[y - 2]?.interestPaid || 0);
      
      // Depreciation Calculation
      const buildingValue = price * mergedInputs.buildingPct;
      let depreciationThisYear = 0;
      if (costSegregation && y===1) {
          // Simplified: 20% of building value in year 1
          depreciationThisYear = buildingValue * 0.20; 
      } else {
          // Standard straight-line over 27.5 years
          depreciationThisYear = buildingValue / 27.5;
      }

      const taxSavings = (interestThisYear + (price * taxesPct) + depreciationThisYear) * mergedInputs.defaultMarginalRate;

      ledger.push({
        year: y,
        nominalCashFlow: nominalAnnualCashFlow,
        principalPaid: financials.principalPaid,
        loanBalance: financials.balance, 
        taxSavings: taxSavings
      });
    }
    
    const finalLedgerEntry = ledger[timelineYears - 1] || { principalPaid: 0, loanBalance: loan };
    
    // Convert final nominal values to real dollars
    const cpiTimelineEnd = cpiSeries[cpiSeries.length-1];
    const gains = realroi.appreciationGain(price, gainsRate, timelineYears);
    const realGains = gains * (cpiBase / cpiTimelineEnd);
    
    const principalPaid = finalLedgerEntry.principalPaid;
    const realPrincipalPaid = principalPaid * (cpiBase / cpiTimelineEnd);
    
    let realCashFlow = 0;
    let realTaxSavings = 0;
    for (let y = 0; y < timelineYears; y++) {
        const cpiYearEnd = cpiSeries[(y + 1) * 12 - 1] || cpiTimelineEnd;
        realCashFlow += (ledger[y]?.nominalCashFlow || 0) * (cpiBase / cpiYearEnd);
        realTaxSavings += (ledger[y]?.taxSavings || 0) * (cpiBase / cpiYearEnd);
    }

    const totalRealROI = realGains + realPrincipalPaid + realCashFlow + realTaxSavings;

    const salePrice = price + gains;
    const finalSaleCosts = salePrice * saleCostPct;
    const loanPayoff = finalLedgerEntry.loanBalance;
    const netProceeds = salePrice - finalSaleCosts - loanPayoff;
    
    const totalInvestment = downPayment + closingCosts + reserves;
    const equityInitialInvestment = downPayment + closingCosts; // Per user feedback
    const roiPct = totalInvestment > 0 ? totalRealROI / totalInvestment : 0;
    
    // IRR Calculation
    let monthlyNominalCashFlows = [-totalInvestment];
    for (let y = 0; y < timelineYears; y++) {
      for (let m = 0; m < 12; m++) { monthlyNominalCashFlows.push((ledger[y]?.nominalCashFlow || 0) / 12); }
    }
    if(monthlyNominalCashFlows.length > 1) monthlyNominalCashFlows[monthlyNominalCashFlows.length - 1] += netProceeds;
    const monthlyRealCashFlows = monthlyNominalCashFlows.map((cf, i) => cf * (cpiBase / (cpiSeries[i] || cpiTimelineEnd)));
    
    // Simplified IRR calc
    let irr = 0;
    if(monthlyRealCashFlows.length > 1 && monthlyRealCashFlows[0] !== 0) {
        const finalValue = monthlyRealCashFlows.slice(1).reduce((a,b)=>a+b,0);
        irr = Math.pow(finalValue / -monthlyRealCashFlows[0], 1/timelineYears) - 1;
    }

    // Equities Calculation
    const totalFeeBps = etfErBps + (advisorFee * 10000);
    const feeMo = (totalFeeBps / 10000) / 12;
    let equityValue = 0;
    if (fairnessMode === 'initial') {
        equityValue = equityInitialInvestment * Math.pow(1 + 0.08 - inflationRate - (totalFeeBps/10000), timelineYears);
    } else { // Matched cash flows
        equityValue = equityInitialInvestment;
        for(let i=0; i<timelineYears*12; i++) {
             equityValue *= (1 + (0.08/12) - feeMo); // Grow
             const yearIndex = Math.floor(i / 12);
             const realMonthlyCashFlow = ((ledger[yearIndex]?.nominalCashFlow || 0) / 12) * (cpiBase / (cpiSeries[i] || cpiTimelineEnd));
             equityValue += realMonthlyCashFlow; // Add/remove cash
        }
    }
    
    setResults({
      piti,
      rentVsOwn: rentMonthly - piti,
      realGains,
      realPrincipalPaid,
      realCashFlow,
      realTaxSavings,
      totalRealROI, 
      netProceeds,
      totalInvestment, 
      roiPct, 
      irr,
      equityTerminalWealth: equityValue,
    });
    setTimeout(() => setLoading(false), 300);
  }, [deal, DEFAULTS]);

  useEffect(() => {
    calculateResults();
  }, [calculateResults]);
  
  const handleDealChange = (e) => {
    const { id, value, type, checked } = e.target;
    let parsedValue;
    if (type === 'checkbox') {
        parsedValue = checked;
    } else {
        parsedValue = type === 'number' ? parseFloat(value) : value;
    }
    setDeal(prev => ({ ...prev, [id]: parsedValue }));
  };

  const formatCurrency = (val) => val.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <>
      <style>{`
        :root { --bg:#0b0f13; --panel:#12181f; --ink:#e8eef6; --muted:#a6b0be; --accent:#48b674; --warn:#ffb648; --danger:#ff6b6b; }
        html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
        .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
        h1{font-size:20px;margin:0 0 8px} .sub{color:var(--muted);margin:0 0 16px}
        .card{background:var(--panel);border:1px solid #1f2630;border-radius:12px;padding:14px;margin-bottom:12px}
        .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}
        .col-12{grid-column:span 12}.col-8{grid-column:span 8}.col-6{grid-column:span 6}.col-4{grid-column:span 4}.col-3{grid-column:span 3}
        label{display:flex;align-items:center;font-weight:600;margin-bottom:6px; color: var(--muted); font-size: 13px; gap: 4px;}
        input,select{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2a3340;background:#0e1319;color:var(--ink); font-size: 14px;}
        table{width:100%;border-collapse:collapse} th,td{text-align:right;padding:9px;border-bottom:1px solid #1f2630}
        th:first-child,td:first-child{text-align:left} .ok{color:var(--accent);font-weight:700}.danger{color:var(--danger);font-weight:700}
        .hint{color:var(--muted);font-size:12px} .split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        @media(max-width:880px){.grid{grid-template-columns:repeat(6,1fr)!important;}.col-4{grid-column:span 3!important;}.split{grid-template-columns:1fr;}}
        .tabs{display:flex;gap:4px;margin-bottom:10px;padding:4px;background:#0e1319;border-radius:10px;}
        .tab{flex:1;text-align:center;padding:8px;border-radius:8px;cursor:pointer;font-weight:600;color:var(--muted); transition: all .2s;}
        .tab.active{background:#2a3340;color:var(--ink);}
        .info-icon { color: var(--muted); }
        .tooltip-container { position: relative; display: inline-block; cursor: pointer; }
        .tooltip-text { visibility: hidden; width: 220px; background-color: #2a3340; color: var(--ink); text-align: center; border-radius: 6px; padding: 8px; position: absolute; z-index: 1; bottom: 125%; left: 50%; margin-left: -110px; opacity: 0; transition: opacity 0.3s; font-weight: normal; font-size: 12px;}
        .tooltip-container:hover .tooltip-text { visibility: visible; opacity: 1; }
        .checkbox-label { flex-direction: row; align-items: center; gap: 8px; color: var(--ink);}
        input[type="checkbox"] { width: auto; }
      `}</style>
      <div className="wrap">
        <h1>RealROI — Ready-to-Use</h1>
        <p className="sub">All numbers shown in <b>today’s dollars</b>. Equities comparison supports <b>Initial-only</b> and <b>Same-cash-flows</b>.</p>
        
        <div className="split">
            <div className="inputs">
                {/* Property & Loan Inputs */}
                <div className="card">
                    <div className="grid">
                        <div className="col-6"><label>Price ($)</label><input id="price" type="number" value={deal.price} step="1000" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Down %</label><select id="downPct" value={deal.downPct} onChange={handleDealChange}><option value="0.035">3.5%</option><option value="0.05">5%</option><option value="0.10">10%</option><option value="0.20">20%</option><option value="0.25">25%</option></select></div>
                        <div className="col-3"><label>Rate (APR %)</label><input id="rate" type="number" value={deal.rate} step="0.01" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Term (years)</label><input id="termYears" type="number" value={deal.termYears} step="1" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Taxes (% of price)</label><input id="taxesPct" type="number" value={(deal.taxesPct * 100).toFixed(2)} onChange={e => setDeal({...deal, taxesPct: parseFloat(e.target.value)/100})} step="0.01"/></div>
                        <div className="col-3"><label>Insurance ($/yr)</label><input id="insuranceAnnual" type="number" value={deal.insuranceAnnual} step="50" onChange={handleDealChange}/></div>
                        <div className="col-3"><label>Rent ($/mo)</label><input id="rentMonthly" type="number" value={deal.rentMonthly} step="50" onChange={handleDealChange}/></div>
                        <div className="col-6"><label>Closing Costs ($)</label><input id="closingCosts" type="number" value={deal.closingCosts} step="100" onChange={handleDealChange}/></div>
                        <div className="col-6"><label>Reserves ($)</label><input id="reserves" type="number" value={deal.reserves} step="100" onChange={handleDealChange}/></div>
                    </div>
                </div>
                {/* Assumptions and Comparison Inputs */}
                <div className="card">
                     <div className="grid">
                        <div className="col-6"><label>Gains % (Annual)</label><input id="gainsRate" type="number" value={deal.gainsRate * 100} onChange={e => setDeal({...deal, gainsRate: parseFloat(e.target.value)/100})} step="0.1"/></div>
                        <div className="col-6"><label>Inflation % (Annual)</label><select id="inflationRate" value={deal.inflationRate} onChange={handleDealChange}><option value="0.03">3%</option><option value="0.04">4%</option><option value="0.05">5%</option><option value="0.06">6%</option></select></div>
                        <div className="col-12"><hr style={{border: '1px solid #1f2630', margin: '10px 0'}} /></div>
                        <div className="col-6"><label>Comparison Mode <InfoIcon tooltip="Initial-only invests your down payment & closing costs into stocks. Same-cash-flows also invests or withdraws the property's monthly cash flows for a true apples-to-apples comparison." /></label><select id="fairnessMode" value={deal.fairnessMode} onChange={handleDealChange}><option value="matched">Same-cash-flows</option><option value="initial">Initial-only</option></select></div>
                        <div className="col-6"><label>Advisor Fee <InfoIcon tooltip="Annual fee paid to a financial advisor for managing your stock portfolio."/></label><select id="advisorFee" value={deal.advisorFee} onChange={handleDealChange}><option value="0.01">1%</option><option value="0.015">1.5%</option><option value="0.02">2%</option><option value="0">0%</option></select></div>
                        <div className="col-6"><label>Sale Costs % <InfoIcon tooltip="Total costs to sell the property, including Realtor fees (typically 3-6%)." /></label><input id="saleCostPct" type="number" value={deal.saleCostPct*100} onChange={e => setDeal({...deal, saleCostPct: parseFloat(e.target.value)/100})} step="0.5"/></div>
                        <div className="col-6"><label>ETF ER (bps) <InfoIcon tooltip="Expense Ratio in Basis Points. Annual fee for the ETF. 100 bps = 1%."/></label><input id="etfErBps" type="number" value={deal.etfErBps} step="1" onChange={handleDealChange}/></div>
                        <div className="col-12"><label className="checkbox-label"><input type="checkbox" id="costSegregation" checked={deal.costSegregation} onChange={handleDealChange} /> Enable Cost Segregation <InfoIcon tooltip="Advanced tax strategy. Typically most beneficial for properties over $400k. Consult a CPA." /></label></div>
                    </div>
                </div>
            </div>
            
            <div className="results">
                <div className="card">
                    <div className="tabs">
                        {[5, 10, 15].map(year => (
                            <div key={year} className={`tab ${deal.timelineYears === year ? 'active' : ''}`} onClick={() => setDeal({...deal, timelineYears: year})}>
                                {year} Years
                            </div>
                        ))}
                    </div>
                    {loading ? <div style={{textAlign: 'center', padding: '50px'}}>Calculating...</div> : results && (
                    <table>
                        <tbody>
                            <tr><td>Est. Monthly PITI</td><td>{formatCurrency(results.piti)}</td></tr>
                            <tr><td>Monthly Savings (vs. Rent)</td><td className={results.rentVsOwn >= 0 ? 'ok' : 'danger'}>{formatCurrency(results.rentVsOwn)}</td></tr>
                            <tr style={{borderTop: '2px solid #2a3340'}}><td>Gains (Appreciation)</td><td className="ok">{formatCurrency(results.realGains)}</td></tr>
                            <tr><td>Principal Paid</td><td className="ok">{formatCurrency(results.realPrincipalPaid)}</td></tr>
                            <tr><td>Cash Flow</td><td className={results.realCashFlow >= 0 ? 'ok' : 'danger'}>{formatCurrency(results.realCashFlow)}</td></tr>
                            <tr><td>Tax Savings</td><td className="ok">{formatCurrency(results.realTaxSavings)}</td></tr>
                            <tr><td><b>Total Real ROI</b></td><td><b>{formatCurrency(results.totalRealROI)}</b></td></tr>
                            <tr><td className="hint">Net Sale Proceeds</td><td className="hint">{formatCurrency(results.netProceeds)}</td></tr>
                            <tr style={{borderTop: '2px solid #2a3340'}}>
                                <td>Equities Comparison <InfoIcon tooltip="The estimated value of an equivalent stock market investment (using your initial cash outlay and matching monthly cash flows)." /></td><td>{formatCurrency(results.equityTerminalWealth)}</td>
                            </tr>
                            <tr>
                                <td><b>Real ROI %</b><p className="hint">vs. {formatCurrency(results.totalInvestment)} invested</p></td>
                                <td><b>{(results.roiPct * 100).toFixed(1)}%</b></td>
                            </tr>
                             <tr>
                                <td><b>Real IRR % </b><InfoIcon tooltip="Internal Rate of Return. The annualized return on your investment, adjusted for inflation to show the real growth of your purchasing power."/></td>
                                <td><b>{(results.irr * 100).toFixed(2)}%</b></td>
                            </tr>
                        </tbody>
                    </table>
                    )}
                </div>
            </div>
        </div>
      </div>
    </>
  );
}

