"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentPropsWithoutRef } from "react";

function cx(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 10,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cx("app-tooltip", className)}
        sideOffset={sideOffset}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
