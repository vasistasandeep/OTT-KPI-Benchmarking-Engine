import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Shadcn UI class-name merge helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
