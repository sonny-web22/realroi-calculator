import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import App from "./App.jsx";
import RealROICalculator from "./realroi/RealROICalculator";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/realroi" element={<RealROICalculator />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>
);
