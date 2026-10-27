import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/** Keeps a render crash from taking down the whole page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }

  componentDidCatch(error: unknown) {
    console.error("[ErrorBoundary]", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="min-h-screen bg-[#0A0A0F] flex items-center justify-center p-6">
            <div className="max-w-md text-center space-y-3">
              <div className="text-4xl">⚡</div>
              <h1 className="text-xl font-bold text-[#D4AF37]">
                Something glitched in Olympus
              </h1>
              <p className="text-sm text-[#9E9EAE]">{this.state.message}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 px-6 py-2 rounded-lg bg-[#D4AF37] text-black font-semibold hover:bg-[#F4D03F]"
              >
                Reload
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
