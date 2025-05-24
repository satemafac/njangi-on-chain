import { useMemo } from 'react';

export interface BrowserInfo {
  isInstagram: boolean;
  isTikTok: boolean;
  isFacebook: boolean;
  isTwitter: boolean;
  isLinkedIn: boolean;
  isSnapchat: boolean;
  isInAppBrowser: boolean;
  browserName: string;
  userAgent: string;
}

export const useBrowserDetection = (): BrowserInfo => {
  return useMemo(() => {
    const userAgent = navigator.userAgent || '';
    
    const isInstagram = userAgent.includes('Instagram');
    const isTikTok = userAgent.includes('TikTok') || userAgent.includes('musical_ly');
    const isFacebook = userAgent.includes('FBAN') || userAgent.includes('FBAV');
    const isTwitter = userAgent.includes('Twitter');
    const isLinkedIn = userAgent.includes('LinkedInApp');
    const isSnapchat = userAgent.includes('Snapchat');
    
    const isInAppBrowser = isInstagram || isTikTok || isFacebook || isTwitter || isLinkedIn || isSnapchat;
    
    let browserName = 'unknown browser';
    if (isInstagram) browserName = 'Instagram';
    else if (isTikTok) browserName = 'TikTok';
    else if (isFacebook) browserName = 'Facebook';
    else if (isTwitter) browserName = 'Twitter';
    else if (isLinkedIn) browserName = 'LinkedIn';
    else if (isSnapchat) browserName = 'Snapchat';
    else if (!isInAppBrowser) browserName = 'browser';
    
    return {
      isInstagram,
      isTikTok,
      isFacebook,
      isTwitter,
      isLinkedIn,
      isSnapchat,
      isInAppBrowser,
      browserName,
      userAgent
    };
  }, []);
}; 