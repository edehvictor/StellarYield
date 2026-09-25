export type WalletCapability = 'signTransaction' | 'multiSig' | 'hardwareWallet' | 'dappConnect';

export interface FallbackState {
  isSupported: boolean;
  fallbackMessage: string;
  recommendedAction: string;
}

/**
 * Provides fallback states and UI guidance for unsupported wallet capabilities.
 */
export class WalletCapabilityFallbackManager {
  private supportedCapabilities: Set<WalletCapability>;

  constructor(supportedCapabilities: WalletCapability[]) {
    this.supportedCapabilities = new Set(supportedCapabilities);
  }

  public getCapabilityState(capability: WalletCapability): FallbackState {
    if (this.supportedCapabilities.has(capability)) {
      return {
        isSupported: true,
        fallbackMessage: '',
        recommendedAction: 'Proceed'
      };
    }

    switch (capability) {
      case 'multiSig':
        return {
          isSupported: false,
          fallbackMessage: 'Your current wallet does not support multi-signature transactions natively.',
          recommendedAction: 'Use a smart contract wallet fallback or switch to a compatible wallet (e.g., Freighter).'
        };
      case 'hardwareWallet':
        return {
          isSupported: false,
          fallbackMessage: 'Hardware wallet integration is not available in the current browser environment.',
          recommendedAction: 'Please install the desktop companion app or use a supported browser extension.'
        };
      case 'dappConnect':
        return {
          isSupported: false,
          fallbackMessage: 'DApp connection is not supported by your selected wallet provider.',
          recommendedAction: 'Fallback to manual transaction signing or update your wallet extension.'
        };
      default:
        return {
          isSupported: false,
          fallbackMessage: 'The requested wallet capability is currently unsupported.',
          recommendedAction: 'Please update your wallet or choose a different connection method.'
        };
    }
  }
}
