"use client";

import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

/**
 * Reusable popover menu, styled after the Clerk account popover.
 * Built on Radix dropdown-menu and themed with the app's own tokens
 * (see `.app-menu*` in globals.css). Use for anything from a simple
 * two-option menu to a richer multi-section menu.
 */

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;
export const MenuGroup = MenuPrimitive.Group;
export const MenuRadioGroup = MenuPrimitive.RadioGroup;

export function MenuContent({
  align = "start",
  className,
  sideOffset = 8,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        className={cx("app-menu", className)}
        sideOffset={sideOffset}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function MenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
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

export function MenuRadioItem({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cx("app-menu-item app-menu-radio-item", className)} {...props}>
      <span className="app-menu-indicator" aria-hidden="true">
        <MenuPrimitive.ItemIndicator>
          <Check size={15} strokeWidth={2.4} />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function MenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cx("app-menu-label", className)} {...props} />;
}

export function MenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cx("app-menu-separator", className)} {...props} />;
}
