// strategies.ts - Configuration for yield strategies with beginner-friendly language

import { StrategyConfig, EducationalContent } from '../types/yield.types';

export const STRATEGY_CONFIGS: Record<string, StrategyConfig> = {
  conservative: {
    type: 'conservative',
    name: 'Conservative',
    displayName: 'Stable Earnings',
    apy: '6.8%',
    risk: 'low',
    color: 'green',
    description: 'Stable earnings through lending',
    detailedDescription: 'Like a high-yield savings account - your money earns steady returns by lending to verified borrowers.',
    protocols: ['NAVI Protocol'],
    allocation: {
      navi: 100,
      cetus: 0
    }
  },
  balanced: {
    type: 'balanced',
    name: 'Balanced',
    displayName: 'Smart Growth',
    apy: '8.5%',
    risk: 'medium',
    color: 'yellow',
    description: 'Mixed strategy for better returns',
    detailedDescription: 'Like a diversified investment portfolio - combines safe lending with some trading for higher returns.',
    protocols: ['NAVI Protocol', 'Cetus DEX'],
    allocation: {
      navi: 70,
      cetus: 30
    }
  },
  aggressive: {
    type: 'aggressive',
    name: 'Aggressive',
    displayName: 'Maximum Growth',
    apy: '10%+',
    risk: 'higher',
    color: 'orange',
    description: 'Maximum earnings potential',
    detailedDescription: 'Like active trading - focuses on trading opportunities for the highest possible returns.',
    protocols: ['NAVI Protocol', 'Cetus DEX'],
    allocation: {
      navi: 50,
      cetus: 50
    }
  }
};

export const EDUCATIONAL_CONTENT: Record<string, EducationalContent> = {
  conservative: {
    title: 'Stable Earnings Strategy',
    shortDescription: 'Your money earns 6.8% yearly by lending to verified borrowers',
    detailedExplanation: 'This strategy works like a high-yield savings account. Your security deposits are lent to borrowers who need SUI tokens, and they pay interest for borrowing. The NAVI protocol has a proven track record and your funds are always backed by collateral.',
    risksAndBenefits: {
      benefits: [
        'Steady, predictable returns',
        'Very low risk of loss',
        'Funds are always backed by collateral',
        'Easy to understand and track'
      ],
      risks: [
        'Lower returns than other strategies',
        'Returns may vary slightly with market conditions'
      ]
    },
    suitableFor: [
      'First-time DeFi users',
      'Those who prefer stability',
      'Conservative investors',
      'Anyone wanting predictable returns'
    ]
  },
  balanced: {
    title: 'Smart Growth Strategy',
    shortDescription: 'Combines safe lending (70%) with smart trading (30%) for 8.5% yearly returns',
    detailedExplanation: 'This strategy is like having both a savings account and some investments. Most of your money (70%) earns steady returns through lending, while a smaller portion (30%) participates in trading to boost overall returns.',
    risksAndBenefits: {
      benefits: [
        'Higher returns than conservative',
        'Still relatively stable',
        'Diversified across two proven protocols',
        'Good balance of safety and growth'
      ],
      risks: [
        'Slightly more variable returns',
        'Trading portion may have short-term fluctuations',
        'More complex than conservative strategy'
      ]
    },
    suitableFor: [
      'Users comfortable with some variability',
      'Those wanting better returns with moderate risk',
      'Investors with diversified mindset',
      'Medium-term savers'
    ]
  },
  aggressive: {
    title: 'Maximum Growth Strategy',
    shortDescription: 'Equal mix of lending and trading for 10%+ yearly returns',
    detailedExplanation: 'This strategy maximizes your earning potential by equally splitting between safe lending and active trading. While this offers the highest returns, it also means more day-to-day variation in your balance.',
    risksAndBenefits: {
      benefits: [
        'Highest potential returns (10%+)',
        'Takes advantage of market opportunities',
        'Still includes safe lending component',
        'Can significantly boost circle earnings'
      ],
      risks: [
        'More variable day-to-day returns',
        'Trading portion is affected by market volatility',
        'Requires more active monitoring',
        'Not suitable for risk-averse users'
      ]
    },
    suitableFor: [
      'Experienced DeFi users',
      'Those comfortable with market fluctuations',
      'Long-term focused investors',
      'Users wanting maximum returns'
    ]
  }
}; 