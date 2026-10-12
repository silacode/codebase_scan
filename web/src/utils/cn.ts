import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Later Tailwind utilities win on conflict.
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
