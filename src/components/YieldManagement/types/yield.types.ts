// yield.types.ts - Type definitions for yield management system

export type YieldStrategy = 'conservative' | 'balanced' | 'aggressive';

export type RiskLevel = 'low' | 'medium' | 'higher';

export interface StrategyConfig {
  type: YieldStrategy;
  name: string;
  displayName: string;
  apy: string;
  risk: RiskLevel;
  color: 'green' | 'yellow' | 'orange';
  description: string;
  detailedDescription: string;
  protocols: string[];
  allocation: {
    navi?: number;
    cetus?: number;
  };
}

export interface YieldPosition {
  strategy: YieldStrategy;
  totalDeposited: number;
  currentValue: number;
  totalEarnings: number;
  monthlyEarnings: number;
  apy: number;
  lastUpdated: number;
}

export interface YieldCalculation {
  principal: number;
  strategy: YieldStrategy;
  projectedMonthly: number;
  projectedYearly: number;
  riskScore: number;
}

export interface EducationalContent {
  title: string;
  shortDescription: string;
  detailedExplanation: string;
  risksAndBenefits: {
    benefits: string[];
    risks: string[];
  };
  suitableFor: string[];
} 