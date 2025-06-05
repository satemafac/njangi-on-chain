// index.ts - Export all yield management components

// Main section component
export { YieldStrategySection } from './YieldStrategySection';

// Individual components
export { StrategySelector } from './components/StrategySelector';
export { StrategyCard } from './components/StrategyCard';
export { RiskIndicator, RiskExplanation, RiskComparison } from './components/RiskIndicator';
export { EducationalTooltip, InfoIcon } from './components/EducationalTooltip';

// Configuration and types
export { STRATEGY_CONFIGS, EDUCATIONAL_CONTENT } from './config/strategies';
export type { 
  YieldStrategy, 
  RiskLevel, 
  StrategyConfig, 
  YieldPosition, 
  YieldCalculation, 
  EducationalContent 
} from './types/yield.types'; 