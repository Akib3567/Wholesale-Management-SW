import { Moon, Sun } from 'lucide-react';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { useTheme } from './ThemeContext';

export function ThemeToggle({ className, showLabel = true }: { className?: string; showLabel?: boolean }) {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <Button
      variant="outline"
      size={showLabel ? 'sm' : 'icon'}
      onClick={toggle}
      className={cn(className)}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      {showLabel && (dark ? 'Light mode' : 'Dark mode')}
    </Button>
  );
}
