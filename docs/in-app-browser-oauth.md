# Handling OAuth in In-App Browsers

## Problem

When users access your web app through social media in-app browsers (Instagram, TikTok, Facebook, etc.), Google OAuth fails with a "Access blocked: This request is blocked by Google's policies" error (Error 403: disallowed_useragent). This happens because Google considers these browsers "insecure" for OAuth flows.

## Root Cause

Google's OAuth security policies block authentication requests from:
- Instagram's in-app browser
- TikTok's in-app browser  
- Facebook's in-app browser
- Twitter's in-app browser
- LinkedIn's in-app browser
- Snapchat's in-app browser
- Other embedded webviews

## Solution

Our implementation detects in-app browsers and provides users with a guided flow to complete OAuth in their default browser:

### 1. Browser Detection

```typescript
// hooks/useBrowserDetection.ts
export const useBrowserDetection = (): BrowserInfo => {
  return useMemo(() => {
    const userAgent = navigator.userAgent || '';
    
    const isInstagram = userAgent.includes('Instagram');
    const isTikTok = userAgent.includes('TikTok') || userAgent.includes('musical_ly');
    const isFacebook = userAgent.includes('FBAN') || userAgent.includes('FBAV');
    // ... other detections
    
    const isInAppBrowser = isInstagram || isTikTok || isFacebook || /* ... */;
    
    return { isInAppBrowser, browserName, /* ... */ };
  }, []);
};
```

### 2. Conditional Login Flow

```typescript
// components/LoginButton.tsx
const handleLogin = async (provider: OAuthProvider) => {
  if (browser.isInAppBrowser) {
    // Generate login URL but show modal instead of redirecting
    const { loginUrl } = await fetch('/api/zkLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'beginLogin', provider })
    }).then(res => res.json());
    
    setLoginUrl(loginUrl);
    setShowInAppModal(true);
  } else {
    // Normal browser - proceed with regular login
    login(provider);
  }
};
```

### 3. User Guidance Modal

The `InAppBrowserModal` component provides:
- Clear explanation of why browser switch is needed
- One-click URL copying
- "Open in Browser" button
- Step-by-step instructions
- Platform-specific tips (iOS/Android)

## User Experience

### Before (Error State)
1. User clicks "Login with Google" in Instagram
2. Redirects to Google OAuth
3. Google shows "Access blocked" error
4. User is stuck and confused

### After (Guided Flow)
1. User sees warning banner about in-app browser
2. Clicks "Login with Google" 
3. Modal appears with clear instructions
4. **Primary method**: User copies link and opens in default browser
5. **Alternative methods**: Share link or attempt direct opening
6. Completes OAuth successfully
7. Returns to app automatically

## Implementation Features

### 🎯 **Smart User Guidance**
- **Copy Link** (Primary): Most reliable method across all platforms
- **Platform-specific instructions**: Tailored steps for iOS, Android, and desktop
- **Share Link**: Uses native sharing on mobile devices (when available)
- **Attempt Browser Open**: Tries various methods to force external browser

### 🔧 **Technical Approach**
```typescript
// Primary action - Copy to clipboard (most reliable)
const handleCopyUrl = async () => {
  await navigator.clipboard.writeText(loginUrl);
  // Fallback for older browsers
};

// Secondary action - Attempt external browser opening
const handleOpenInBrowser = () => {
  if (isIOS) {
    // iOS-specific approach
  } else if (isAndroid) {
    // Android intent URLs
    window.location.href = `intent://${url}#Intent;scheme=https;...`;
  } else {
    window.open(loginUrl, '_blank');
  }
};

// Tertiary action - Native sharing (mobile only)
if (navigator.share) {
  navigator.share({ title, text, url: loginUrl });
}
```

### ⚠️ **Known Limitations**

**"Open in Browser" Button Challenges:**
- Instagram iOS: Often still opens in in-app browser
- Facebook Android: May work with intent URLs
- TikTok: Limited external browser support
- **Solution**: Copy method is emphasized as primary action

**Why Copy Link Works Best:**
- ✅ Universal compatibility
- ✅ User has full control
- ✅ Works on all platforms
- ✅ No technical limitations

## Implementation Files

```
src/
├── hooks/
│   └── useBrowserDetection.ts       # Browser detection logic
├── components/
│   ├── LoginButton.tsx              # Updated login component
│   └── InAppBrowserModal.tsx        # Reusable modal component
└── docs/
    └── in-app-browser-oauth.md      # This documentation
```

## Technical Benefits

1. **Security Compliance**: Respects Google's OAuth security policies
2. **Better UX**: Proactive guidance instead of confusing errors
3. **Cross-Platform**: Works on iOS and Android
4. **Reusable**: Modal component can be used anywhere
5. **Accessible**: Clear instructions and visual feedback

## Browser Support

Detects and handles:
- ✅ Instagram (iOS/Android)
- ✅ TikTok (iOS/Android) 
- ✅ Facebook (iOS/Android)
- ✅ Twitter (iOS/Android)
- ✅ LinkedIn (iOS/Android)
- ✅ Snapchat (iOS/Android)
- ✅ Other embedded webviews

## Testing

To test the in-app browser flow:

1. **Instagram**: Open Instagram app → Share a link to your app → Click link
2. **TikTok**: Open TikTok app → Click a bio link or shared link to your app
3. **Chrome DevTools**: Change User Agent to include "Instagram" or "TikTok"

### Testing Different OAuth Providers

The solution works for **all OAuth providers** (Google, Facebook, Apple):

**Facebook Login Testing:**
```bash
# Chrome DevTools Console - Simulate Instagram browser
Object.defineProperty(navigator, 'userAgent', {
  writable: true,
  value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 155.0.0.37.107'
});
```

**Expected Behavior:**
- ✅ Google Login: Shows modal (Google blocks in-app browsers strictly)
- ✅ Facebook Login: Shows modal (Facebook may allow some but we provide consistent UX)  
- ✅ Apple Login: Shows modal (Apple has similar restrictions)

## OAuth Provider Policies

| Provider | In-App Browser Policy | Our Solution |
|----------|----------------------|--------------|
| **Google** | ❌ Strictly blocked | ✅ Modal with guidance |
| **Facebook** | ⚠️ Selectively restricted | ✅ Consistent UX |
| **Apple** | ❌ Generally blocked | ✅ Modal with guidance |

## Future Enhancements

1. **Deep Links**: Add platform-specific deep link handling
2. **Analytics**: Track conversion rates for in-app vs regular browser
3. **Customization**: Allow per-provider messaging
4. **Auto-Detection**: Automatically detect successful OAuth completion

## Related Resources

- [Google OAuth User Agent Policy](https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html)
- [Instagram In-App Browser](https://developers.facebook.com/docs/instagram-basic-display-api/overview)
- [OAuth 2.0 Security Best Practices](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics) 