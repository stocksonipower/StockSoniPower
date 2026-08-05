import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { Check, ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"

// Re-picking the option that's already selected should clear the selection
// (toggle off) instead of being a no-op, for every dropdown in the app that
// uses this component. Two Radix behaviours are in the way, so both are
// handled here rather than in any single page:
//
// 1. Root's controllable-state hook (@radix-ui/react-use-controllable-state)
//    compares the incoming value against the current `value` prop and drops
//    the onValueChange call when they're equal — so a reselect never reaches
//    userland. SelectItem below therefore detects "clicked the already-
//    selected item" itself and calls the consumer's setter directly.
//
// 2. Callers write `value={x || undefined}`, so clearing to "" would hand
//    Root an undefined value, flipping it from controlled to *uncontrolled*
//    mid-flight — at which point it renders its own stale internal value and
//    the cleared option snaps straight back. Normalising a present-but-empty
//    `value` prop to "" keeps Root controlled for its whole lifetime; Radix
//    treats "" as "no selection", which is exactly what shows the placeholder.
const SelectValueContext = React.createContext({ value: undefined, onValueChange: undefined })

const Select = ({ onValueChange, children, ...props }) => {
  // Key presence (not just a defined value) is what marks a caller as
  // controlled — an uncontrolled Select using defaultValue must stay that way.
  const isControlled = "value" in props
  const value = isControlled ? (props.value ?? "") : props.value
  const ctx = React.useMemo(
    () => ({ value: isControlled ? value : undefined, onValueChange }),
    [isControlled, value, onValueChange]
  )
  return (
    <SelectValueContext.Provider value={ctx}>
      <SelectPrimitive.Root {...props} value={value} onValueChange={onValueChange}>
        {children}
      </SelectPrimitive.Root>
    </SelectValueContext.Provider>
  )
}

const SelectGroup = SelectPrimitive.Group

const SelectValue = SelectPrimitive.Value

const SelectTrigger = React.forwardRef(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background data-[placeholder]:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
      className
    )}
    {...props}>
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
))
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName

const SelectScrollUpButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}>
    <ChevronUp className="h-4 w-4" />
  </SelectPrimitive.ScrollUpButton>
))
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName

const SelectScrollDownButton = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}>
    <ChevronDown className="h-4 w-4" />
  </SelectPrimitive.ScrollDownButton>
))
SelectScrollDownButton.displayName =
  SelectPrimitive.ScrollDownButton.displayName

const SelectContent = React.forwardRef(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "relative z-50 max-h-[--radix-select-content-available-height] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-select-content-transform-origin]",
        position === "popper" &&
          "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
        className
      )}
      position={position}
      {...props}>
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn("p-1", position === "popper" &&
          "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]")}>
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
))
SelectContent.displayName = SelectPrimitive.Content.displayName

const SelectLabel = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("px-2 py-1.5 text-sm font-semibold", className)}
    {...props} />
))
SelectLabel.displayName = SelectPrimitive.Label.displayName

const SelectItem = React.forwardRef(({ className, children, value, onClick, onPointerUp, onPointerDown, onKeyDown, ...props }, ref) => {
  const ctx = React.useContext(SelectValueContext)
  // Radix commits a mouse selection on pointerup and unmounts the open content
  // immediately, so a `click` event is never dispatched for mouse users — the
  // toggle has to hook pointerup as well. Keyboard (Enter/Space) and non-mouse
  // pointers go through keydown/click instead, hence all three.
  const firedRef = React.useRef(false)
  const toggleOffIfReselected = () => {
    if (firedRef.current) return
    if (ctx.onValueChange && ctx.value !== undefined && ctx.value === value) {
      firedRef.current = true
      // Radix's own handler runs right after this one, but its call is a no-op:
      // at that point the `value` prop it compares against is still this item's
      // value, so it drops the update and only our clear survives.
      ctx.onValueChange("")
    }
  }
  return (
    <SelectPrimitive.Item
      ref={ref}
      value={value}
      onPointerDown={(event) => {
        firedRef.current = false
        onPointerDown?.(event)
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event)
        toggleOffIfReselected()
      }}
      onClick={(event) => {
        onClick?.(event)
        toggleOffIfReselected()
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === "Enter" || event.key === " ") toggleOffIfReselected()
      }}
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}>
      <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
})
SelectItem.displayName = SelectPrimitive.Item.displayName

const SelectSeparator = React.forwardRef(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-muted", className)}
    {...props} />
))
SelectSeparator.displayName = SelectPrimitive.Separator.displayName

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
}
