import React, { useState, useCallback } from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, User, Info, X, DollarSign } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';

interface Member {
  address: string;
  joinDate?: number;
  status: 'active' | 'suspended' | 'exited';
  position?: number;
}

interface SortableMemberProps {
  member: Member;
  id: string;
  index: number;
  shortenAddress: (address: string) => string;
  isAdmin: boolean;
  isCurrentUserAdmin: boolean;
  onRemoveMember: (memberAddress: string) => void;
  onReturnSecurityDeposit: (memberAddress: string) => void;
}

interface RotationOrderListProps {
  members: Member[];
  adminAddress: string;
  currentUserAddress: string;
  shortenAddress: (address: string) => string;
  onSaveOrder: (newOrder: string[]) => void;
  onCancelEdit: () => void;
  onRemoveMember: (memberAddress: string) => void;
  onReturnSecurityDeposit: (memberAddress: string) => void;
}

// Sortable member component
const SortableMember: React.FC<SortableMemberProps> = ({ 
  member, 
  id,
  index, 
  shortenAddress,
  isAdmin,
  isCurrentUserAdmin,
  onRemoveMember,
  onReturnSecurityDeposit
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
        {isCurrentUserAdmin && (
          <>
            <Tooltip.Provider>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button
                    onClick={() => onReturnSecurityDeposit(member.address)}
                    className="flex items-center justify-center px-3 py-1 bg-green-100 text-green-600 rounded-md hover:bg-green-200 transition-colors text-xs font-medium"
                    title="Return security deposit"
                  >
                    <DollarSign size={14} className="mr-1" />
                    Return Deposit
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className="bg-gray-900 text-white px-3 py-2 rounded text-sm max-w-xs"
                    sideOffset={5}
                  >
                    {isAdmin ? 'Return your security deposit' : 'Return security deposit to this member'}
                    <Tooltip.Arrow className="fill-gray-900" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
            {!isAdmin && (
              <button
                onClick={() => onRemoveMember(member.address)}
                className="flex items-center justify-center w-8 h-8 bg-red-100 text-red-600 rounded-full hover:bg-red-200 transition-colors"
                title="Remove member"
              >
                <X size={16} />
              </button>
            )}
          </>
        )}
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
  onRemoveMember,
  onReturnSecurityDeposit
}) => {
  // Convert members to a sorted array that we can reorder
  const [memberList, setMemberList] = useState<Member[]>([...members]);
  
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
                isCurrentUserAdmin={currentUserAddress === adminAddress}
                onRemoveMember={onRemoveMember}
                onReturnSecurityDeposit={onReturnSecurityDeposit}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      
      <div className="flex justify-end space-x-3 mt-4">
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
  );
};

export default RotationOrderList; 