'use client';

/**
 * TaskFilters - PM Backlog
 *
 * Filter controls for the backlog list: Status, Priority, Type, Area, Sprint, Project.
 * Uses multi-select dropdowns with checkboxes for each filter category,
 * allowing multiple values to be selected simultaneously.
 */

import { useEffect, useState } from 'react';
import { Filter, X } from 'lucide-react';
import { listSprints, listProjects } from '@/lib/pm-queries';
import type { PmSprint, PmProject } from '@/lib/pm-types';
import { STATUS_LABELS, PRIORITY_LABELS, TYPE_LABELS, AREA_LABELS } from '@/lib/pm-types';
import { MultiSelectDropdown } from '@/components/shared/MultiSelectDropdown';
import type { MultiSelectOption } from '@/components/shared/MultiSelectDropdown';

interface TaskFiltersProps {
  statuses: string[];
  priorities: string[];
  types: string[];
  areas: string[];
  sprintIds: string[];
  projectIds: string[];
  onStatusesChange: (statuses: string[]) => void;
  onPrioritiesChange: (priorities: string[]) => void;
  onTypesChange: (types: string[]) => void;
  onAreasChange: (areas: string[]) => void;
  onSprintIdsChange: (sprintIds: string[]) => void;
  onProjectIdsChange: (projectIds: string[]) => void;
}

export function TaskFilters({
  statuses,
  priorities,
  types,
  areas,
  sprintIds,
  projectIds,
  onStatusesChange,
  onPrioritiesChange,
  onTypesChange,
  onAreasChange,
  onSprintIdsChange,
  onProjectIdsChange,
}: TaskFiltersProps) {
  const [sprints, setSprints] = useState<PmSprint[]>([]);
  const [projects, setProjects] = useState<PmProject[]>([]);

  useEffect(() => {
    listSprints().then(setSprints).catch(() => {});
    listProjects().then(setProjects).catch(() => {});
  }, []);

  const hasFilters =
    statuses.length > 0 ||
    priorities.length > 0 ||
    types.length > 0 ||
    areas.length > 0 ||
    sprintIds.length > 0 ||
    projectIds.length > 0;

  function clearAll() {
    onStatusesChange([]);
    onPrioritiesChange([]);
    onTypesChange([]);
    onAreasChange([]);
    onSprintIdsChange([]);
    onProjectIdsChange([]);
  }

  const statusOptions: MultiSelectOption[] = Object.entries(STATUS_LABELS).map(
    ([key, label]) => ({ value: key, label })
  );

  const priorityOptions: MultiSelectOption[] = Object.entries(PRIORITY_LABELS).map(
    ([key, label]) => ({ value: key, label })
  );

  const typeOptions: MultiSelectOption[] = Object.entries(TYPE_LABELS).map(
    ([key, label]) => ({ value: key, label })
  );

  const areaOptions: MultiSelectOption[] = Object.entries(AREA_LABELS).map(
    ([key, label]) => ({ value: key, label })
  );

  const sprintOptions: MultiSelectOption[] = sprints.map((s) => ({
    value: s.id,
    label: s.name,
  }));

  const projectOptions: MultiSelectOption[] = projects.map((p) => ({
    value: p.id,
    label: p.name,
  }));

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-1.5 text-gray-500">
        <Filter className="h-4 w-4" />
        <span className="text-sm font-medium">Filters</span>
      </div>

      {/* Status filter */}
      <MultiSelectDropdown
        label="All Statuses"
        options={statusOptions}
        selected={statuses}
        onChange={onStatusesChange}
      />

      {/* Priority filter */}
      <MultiSelectDropdown
        label="All Priorities"
        options={priorityOptions}
        selected={priorities}
        onChange={onPrioritiesChange}
      />

      {/* Type filter */}
      <MultiSelectDropdown
        label="All Types"
        options={typeOptions}
        selected={types}
        onChange={onTypesChange}
      />

      {/* Area filter */}
      <MultiSelectDropdown
        label="All Areas"
        options={areaOptions}
        selected={areas}
        onChange={onAreasChange}
      />

      {/* Sprint filter */}
      <MultiSelectDropdown
        label="All Sprints"
        options={sprintOptions}
        selected={sprintIds}
        onChange={onSprintIdsChange}
        className="max-w-[180px]"
      />

      {/* Project filter */}
      <MultiSelectDropdown
        label="All Projects"
        options={projectOptions}
        selected={projectIds}
        onChange={onProjectIdsChange}
        className="max-w-[180px]"
      />

      {/* Clear all button */}
      {hasFilters && (
        <button
          onClick={clearAll}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </button>
      )}
    </div>
  );
}
