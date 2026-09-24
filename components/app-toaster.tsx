"use client";

import { Toaster } from "sonner";

export function AppToaster() {
  return (
    <Toaster
      closeButton
      richColors
      position="top-center"
      toastOptions={{
        classNames: {
          actionButton: "app-toast-action",
          cancelButton: "app-toast-cancel",
          closeButton: "app-toast-close",
          toast: "app-toast",
        },
      }}
    />
  );
}
