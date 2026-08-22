import React, { useState, useCallback } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, User, Info, Shuffle } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { shuffleDistinct } from '@/lib/rotation-shuffle';

interface Member {
  address: string;
  joinDate?: number;
  status: 'active' | 'suspended' | 'exited';
  position?: number;
  depositPaid?: boolean;
}

interface SortableMemberProps {
  member: Member;
  id: string;
  index: number;
  shortenAddress: (address: string) => string;
  isAdmin: boolean;
}

interface RotationOrderListProps {
  members: Member[];
  adminAddress: string;
  currentUserAddress: string;
  shortenAddress: (address: string) => string;
  onSaveOrder: (newOrder: string[]) => void;
  onCancelEdit: () => void;
}

// Sortable member component
const SortableMember: React.FC<SortableMemberProps> = ({ 
  member, 
  id,
  index, 
  shortenAddress,
  isAdmin,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });
  
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  
  return (
    <div 
      ref={setNodeRef} 
      style={style}
      className="flex items-center p-3 mb-2 bg-white border border-gray-200 rounded-lg shadow-sm"
    >
      <div 
        className="flex items-center justify-center mr-3 cursor-move" 
        {...attributes} 
        {...listeners}
      >
        <GripVertical size={20} className="text-gray-400" />
      </div>
      <div className="flex items-center flex-1">
        <div className="h-8 w-8 bg-blue-100 rounded-full flex items-center justify-center mr-3">
          <User size={16} className="text-blue-600" />
        </div>
        <div>
          <div className="font-medium text-gray-900">
            {shortenAddress(member.address)}
            {isAdmin && (
              <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5 ml-2">
                Admin
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500">
            Position {index + 1}
          </div>
        </div>
      </div>
      <div className="flex items-center space-x-2">
        <div className="flex items-center justify-center w-8 h-8 bg-blue-50 rounded-full">
          {index + 1}
        </div>
      </div>
    </div>
  );
};

const RotationOrderList: React.FC<RotationOrderListProps> = ({
  members,
  adminAddress,
  currentUserAddress,
  shortenAddress,
  onSaveOrder,
  onCancelEdit,
}) => {
  // Convert members to a sorted array that we can reorder
  const [memberList, setMemberList] = useState<Member[]>([...members]);
  const isCurrentUserAdmin = currentUserAddress === adminAddress;
  
  // Create a list of sortable items with unique IDs
  const items = memberList.map(member => member.address);
  
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
  
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    
    if (active.id !== over?.id && over) {
      setMemberList((items) => {
        const oldIndex = items.findIndex(item => item.address === active.id);
        const newIndex = items.findIndex(item => item.address === over.id);
        
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  }, []);
  
  /**
   * Stages a random order in the list, the same way dragging does. The user
   * still presses Save.
   *
   * This used to live on the parent page and commit straight to the save
   * confirmation, leaving this list untouched — so it looked like nothing had
   * happened, and pressing it again just queued another confirmation for a
   * different order.
   */
  const handleShuffle = useCallback(() => {
    setMemberList((current) => shuffleDistinct(current, (member) => member.address));
  }, []);

  const handleSave = () => {
    // Extract the addresses in the new order
    const newOrderAddresses = memberList.map(member => member.address);
    onSaveOrder(newOrderAddresses);
  };
  
  return (
    <div className="mb-4">
      <h3 className="text-lg font-medium text-gray-900 mb-2">Manage Rotation Order</h3>
      <div className="text-sm text-gray-500 mb-4 flex items-center">
        <p>
          Drag and drop members to set the order in which they will receive payouts. 
          Position 1 will receive the first payout, position 2 the second, and so on.
        </p>
        <Tooltip.Provider>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button className="ml-2 inline-flex items-center p-1 rounded-full bg-blue-100 text-blue-600 hover:bg-blue-200">
                <Info size={16} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                className="bg-gray-900 text-white px-3 py-2 rounded text-sm max-w-xs"
                sideOffset={5}
              >
                <p className="font-medium">Admin can be in any position</p>
                <p className="mt-1">Unlike previous versions, you can now place the admin in any position in the rotation order.</p>
                <Tooltip.Arrow className="fill-gray-900" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      </div>
      {isCurrentUserAdmin && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Rotation order is managed here only. Deposit returns and member removals are handled in the Members table.
        </div>
      )}
      
      <DndContext 
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext 
          items={items}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2 my-4">
            {memberList.map((member, index) => (
              <SortableMember
                key={member.address}
                id={member.address}
                member={member}
                index={index}
                shortenAddress={shortenAddress}
                isAdmin={member.address === adminAddress}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={handleShuffle}
          disabled={memberList.length < 2}
          className="inline-flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-md shadow-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Shuffle size={16} className="mr-2" />
          Shuffle
        </button>
        <div className="flex space-x-3">
        <button
          onClick={onCancelEdit}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md shadow-sm hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="px-4 py-2 bg-blue-600 text-white rounded-md shadow-sm hover:bg-blue-700"
        >
          Save Rotation Order
        </button>
        </div>
      </div>
    </div>
  );
};

export default RotationOrderList; 
