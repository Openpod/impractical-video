"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Reusable modal/dialog. Shares the popover menu's surface and open/close
 * animation feel (scale + fade) so anything that pops up has one consistent
 * style. Built on Radix Dialog; themed via `.app-dialog*` in globals.css.
 */

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  children,
  className,
  showClose = true,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="app-dialog-overlay" />
      <DialogPrimitive.Content className={cx("app-dialog", className)} {...props}>
        {children}
        {showClose ? (
          <DialogPrimitive.Close aria-label="Close" className="app-dialog-close">
            <X size={16} />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cx("app-dialog-header", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cx("app-dialog-footer", className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cx("app-dialog-title", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cx("app-dialog-description", className)} {...props} />;
}
