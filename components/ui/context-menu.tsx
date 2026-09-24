"use client";

import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Cursor-anchored right-click menu, sharing the exact `.app-menu*` styling as
 * the standardized dropdown `Menu` (components/ui/menu.tsx). Built on Radix
 * context-menu so it opens from the pointer position.
 */

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;

export function ContextMenuContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cx("app-menu", className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      className={cx(
        "app-menu-item",
        variant === "destructive" && "app-menu-item-destructive",
        inset && "is-inset",
        className,
      )}
      {...props}
    />
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cx("app-menu-label", className)} {...props} />;
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cx("app-menu-separator", className)} {...props} />;
}
