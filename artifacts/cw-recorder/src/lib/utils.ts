import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function apiUrl(path: string): string {
  if (path.startsWith("http")) return path;
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${BASE}${clean}`;
}
